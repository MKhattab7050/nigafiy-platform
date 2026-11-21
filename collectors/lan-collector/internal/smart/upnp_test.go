package smart

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseSSDPLocation(t *testing.T) {
	loc, ok := ParseSSDPLocation(fixture(t, "ssdp_igd_response.txt"))
	if !ok || loc != "http://192.168.1.2:1900/igd.xml" {
		t.Fatalf("got %q ok=%v", loc, ok)
	}
	if _, ok := ParseSSDPLocation(fixture(t, "ssdp_other_response.txt")); ok {
		t.Error("a non-gateway device (DIAL) was taken for an IGD")
	}
	if _, ok := ParseSSDPLocation([]byte("M-SEARCH * HTTP/1.1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n")); ok {
		t.Error("a search request was taken for a response")
	}
	old := strings.Replace(string(fixture(t, "ssdp_igd_response.txt")), "HTTP/1.1 200 OK", "HTTP/1.0 200 OK", 1)
	if loc, ok := ParseSSDPLocation([]byte(old)); !ok || loc == "" {
		t.Error("an HTTP/1.0 answer from a UPnP 1.0 gateway was refused")
	}
}

func TestParseIGDDescription(t *testing.T) {
	d, err := ParseIGDDescription(fixture(t, "igd_description.xml"), "http://192.168.1.2:1900/igd.xml")
	if err != nil {
		t.Fatal(err)
	}
	if d.FriendlyName != "VMG3625-T50B" || d.Manufacturer != "Zyxel" || d.Model != "VMG3625" ||
		d.ServiceType != "urn:schemas-upnp-org:service:WANIPConnection:1" || d.ControlURL != "http://192.168.1.2:1900/ctl/IPConn" {
		t.Fatalf("got %+v", d)
	}
	if _, err := ParseIGDDescription([]byte("<root><device><friendlyName>x</friendlyName></device></root>"), "http://192.168.1.2/"); err == nil {
		t.Error("a description without a WAN connection service was accepted")
	}
	if _, err := ParseIGDDescription([]byte("not xml"), "http://192.168.1.2/"); err == nil {
		t.Error("garbage was accepted")
	}
}

func TestMappingFromFields(t *testing.T) {
	f := ParseSOAPFields(fixture(t, "soap_mapping_entry.xml"))
	m, ok := MappingFromFields(f)
	if !ok {
		t.Fatalf("fields %v", f)
	}
	lease := uint32(0)
	if m.Protocol != "TCP" || m.ExternalPort != 32400 || m.InternalClient != "192.168.1.30" || m.InternalPort != 32400 ||
		m.Description != "Plex Media Server" || !m.Enabled || m.RemoteHost != "" || m.LeaseSeconds == nil || *m.LeaseSeconds != lease {
		t.Fatalf("got %+v", m)
	}
	f["NewInternalClient"] = "fe80::1"
	if _, ok := MappingFromFields(f); ok {
		t.Error("a non-IPv4 internal client was reported")
	}
	f["NewInternalClient"], f["NewProtocol"] = "192.168.1.30", "SCTP"
	if _, ok := MappingFromFields(f); ok {
		t.Error("an unknown protocol was reported")
	}
	f["NewProtocol"], f["NewEnabled"] = "UDP", "0"
	if m, ok := MappingFromFields(f); !ok || m.Enabled {
		t.Error("a disabled mapping was not reported as disabled")
	}
	if code := ParseSOAPFields(fixture(t, "soap_fault_713.xml"))["errorCode"]; code != "713" {
		t.Errorf("fault code %q", code)
	}
}

// TestAuditGatewayReadsOnly runs the audit against a local double: description, external address,
// one mapping, then the end-of-list fault. Only the two read actions may be called.
func TestAuditGatewayReadsOnly(t *testing.T) {
	var mu sync.Mutex
	var actions []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/igd.xml":
			_, _ = w.Write(fixture(t, "igd_description.xml"))
		case r.Method == http.MethodGet && r.URL.Path == "/away.xml":
			desc := strings.Replace(string(fixture(t, "igd_description.xml")), "<device>", "<URLBase>http://192.0.2.1:5000/</URLBase><device>", 1)
			_, _ = w.Write([]byte(desc))
		case r.Method == http.MethodPost && r.URL.Path == "/ctl/IPConn":
			action := r.Header.Get("SOAPAction")
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			actions = append(actions, action)
			mu.Unlock()
			switch {
			case strings.HasSuffix(action, `#GetExternalIPAddress"`):
				_, _ = w.Write([]byte(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`))
			case strings.Contains(string(body), "<NewPortMappingIndex>0<"):
				_, _ = w.Write(fixture(t, "soap_mapping_entry.xml"))
			default:
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write(fixture(t, "soap_fault_713.xml"))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	gw := AuditGateway(context.Background(), u.Hostname(), srv.URL+"/igd.xml", srv.Client())
	if gw.Error != "" || gw.ExternalIP != "203.0.113.7" || gw.FriendlyName != "VMG3625-T50B" || len(gw.Mappings) != 1 || gw.MappingsTruncated {
		t.Fatalf("got %+v", gw)
	}
	for _, a := range actions {
		if !strings.Contains(a, "#GetExternalIPAddress") && !strings.Contains(a, "#GetGenericPortMappingEntry") {
			t.Errorf("a non-read action was sent: %s", a)
		}
	}
	// A description or a control URL on another host is never followed.
	gw = AuditGateway(context.Background(), "127.0.0.2", srv.URL+"/igd.xml", srv.Client())
	if !strings.Contains(gw.Error, "description URL points away") {
		t.Fatalf("description on another host: %+v", gw)
	}
	mu.Lock()
	before := len(actions)
	mu.Unlock()
	gw = AuditGateway(context.Background(), u.Hostname(), srv.URL+"/away.xml", srv.Client())
	mu.Lock()
	after := len(actions)
	mu.Unlock()
	if !strings.Contains(gw.Error, "control URL points away") || after != before {
		t.Fatalf("control URL on another host: %+v (actions %d → %d)", gw, before, after)
	}
}
