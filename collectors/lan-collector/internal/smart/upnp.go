package smart

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// UPnP IGD audit. The collector multicasts an SSDP search for Internet Gateway Devices on each
// authorized interface, reads the description of the gateways that answer from an authorized
// address, and lists their port mappings with GetGenericPortMappingEntry (index 0, 1, 2… until the
// gateway says "no such entry"). Only read actions are ever sent.

// UPnPMapping is one port forward the gateway reports.
type UPnPMapping struct {
	Protocol       string  `json:"protocol"`
	ExternalPort   int     `json:"external_port"`
	RemoteHost     string  `json:"remote_host"`
	InternalClient string  `json:"internal_client"`
	InternalPort   int     `json:"internal_port"`
	Description    string  `json:"description,omitempty"`
	Enabled        bool    `json:"enabled"`
	LeaseSeconds   *uint32 `json:"lease_seconds,omitempty"`
}

// UPnPGateway is one Internet Gateway Device and what it said.
type UPnPGateway struct {
	Address           string        `json:"address"`
	FriendlyName      string        `json:"friendly_name,omitempty"`
	Manufacturer      string        `json:"manufacturer,omitempty"`
	Model             string        `json:"model,omitempty"`
	ServiceType       string        `json:"service_type,omitempty"`
	ExternalIP        string        `json:"external_ip,omitempty"`
	Error             string        `json:"error,omitempty"`
	MappingsTruncated bool          `json:"mappings_truncated"`
	Mappings          []UPnPMapping `json:"mappings"`
}

const (
	maxGateways      = 8
	maxMappings      = 256
	maxDescription   = 512 << 10
	upnpHTTPTimeout  = 5 * time.Second
	ssdpWait         = 3 * time.Second
	soapResponseSize = 64 << 10
)

var ssdpAddr = &net.UDPAddr{IP: net.IPv4(239, 255, 255, 250), Port: 1900}

var igdTargets = []string{
	"urn:schemas-upnp-org:device:InternetGatewayDevice:1",
	"urn:schemas-upnp-org:device:InternetGatewayDevice:2",
}

// wanServices in order of preference.
var wanServices = []string{
	"urn:schemas-upnp-org:service:WANIPConnection:2",
	"urn:schemas-upnp-org:service:WANIPConnection:1",
	"urn:schemas-upnp-org:service:WANPPPConnection:1",
}

func ssdpSearch(st string) []byte {
	return []byte("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: " + st + "\r\n\r\n")
}

// ParseSSDPLocation returns the LOCATION header of an SSDP search response for an IGD.
func ParseSSDPLocation(msg []byte) (string, bool) {
	r := textproto.NewReader(bufio.NewReader(bytes.NewReader(msg)))
	status, err := r.ReadLine()
	if err != nil || !strings.HasPrefix(status, "HTTP/1.1 200") {
		return "", false
	}
	h, _ := r.ReadMIMEHeader()
	loc := h.Get("Location")
	st := h.Get("St")
	if loc == "" || !strings.Contains(st, "InternetGatewayDevice") && !strings.Contains(st, "WANIPConnection") && !strings.Contains(st, "WANPPPConnection") {
		return "", false
	}
	return loc, true
}

// DiscoverIGD multicasts SSDP searches from each local address and returns description URLs by
// gateway address. Only answers from addresses inside allowed are kept, and only when the
// description URL points back at the address that answered (no fetching elsewhere).
func DiscoverIGD(ctx context.Context, locals []netip.Addr, allowed []netip.Prefix) map[string]string {
	found := map[string]string{}
	done := make(chan map[string]string, len(locals))
	for _, local := range locals {
		go func() { done <- searchFrom(ctx, local, allowed) }()
	}
	for range locals {
		for k, v := range <-done {
			if _, ok := found[k]; !ok && len(found) < maxGateways {
				found[k] = v
			}
		}
	}
	return found
}

func searchFrom(ctx context.Context, local netip.Addr, allowed []netip.Prefix) map[string]string {
	out := map[string]string{}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: local.AsSlice(), Port: 0})
	if err != nil {
		return out
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	for _, st := range append(igdTargets, wanServices[1], wanServices[2]) {
		_, _ = conn.WriteToUDP(ssdpSearch(st), ssdpAddr)
	}
	deadline := time.Now().Add(ssdpWait)
	buf := make([]byte, 4096)
	for ctx.Err() == nil {
		_ = conn.SetReadDeadline(deadline)
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			break
		}
		src, ok := netip.AddrFromSlice(from.IP.To4())
		if !ok || !inAny(src, allowed) {
			continue
		}
		loc, ok := ParseSSDPLocation(buf[:n])
		if !ok {
			continue
		}
		u, err := url.Parse(loc)
		if err != nil || u.Scheme != "http" || u.Hostname() != src.String() {
			continue
		}
		if _, seen := out[src.String()]; !seen {
			out[src.String()] = loc
		}
	}
	return out
}

type xmlService struct {
	ServiceType string `xml:"serviceType"`
	ControlURL  string `xml:"controlURL"`
}

type xmlDevice struct {
	DeviceType   string       `xml:"deviceType"`
	FriendlyName string       `xml:"friendlyName"`
	Manufacturer string       `xml:"manufacturer"`
	ModelName    string       `xml:"modelName"`
	Services     []xmlService `xml:"serviceList>service"`
	Devices      []xmlDevice  `xml:"deviceList>device"`
}

type xmlRoot struct {
	URLBase string    `xml:"URLBase"`
	Device  xmlDevice `xml:"device"`
}

// IGDDescription is what the device description says.
type IGDDescription struct {
	FriendlyName, Manufacturer, Model string
	ServiceType, ControlURL           string
}

// ParseIGDDescription finds the WAN connection service in a device description and resolves its
// control URL against the URLBase (or the description's own location).
func ParseIGDDescription(body []byte, location string) (IGDDescription, error) {
	var root xmlRoot
	if err := xml.Unmarshal(body, &root); err != nil {
		return IGDDescription{}, fmt.Errorf("the device description is not valid XML: %w", err)
	}
	d := IGDDescription{FriendlyName: cleanText(root.Device.FriendlyName, 120), Manufacturer: cleanText(root.Device.Manufacturer, 120), Model: cleanText(root.Device.ModelName, 120)}
	var all []xmlService
	var walk func(x xmlDevice)
	walk = func(x xmlDevice) {
		all = append(all, x.Services...)
		for _, c := range x.Devices {
			walk(c)
		}
	}
	walk(root.Device)
	for _, want := range wanServices {
		for _, s := range all {
			if strings.TrimSpace(s.ServiceType) == want && strings.TrimSpace(s.ControlURL) != "" {
				base := location
				if b := strings.TrimSpace(root.URLBase); b != "" {
					base = b
				}
				bu, err := url.Parse(base)
				if err != nil {
					return d, fmt.Errorf("invalid base URL in the device description")
				}
				cu, err := bu.Parse(strings.TrimSpace(s.ControlURL))
				if err != nil {
					return d, fmt.Errorf("invalid control URL in the device description")
				}
				d.ServiceType, d.ControlURL = want, cu.String()
				return d, nil
			}
		}
	}
	return d, errors.New("the gateway does not offer a WAN IP/PPP connection service")
}

// soapFault carries the UPnP error code of a failed action (713 = SpecifiedArrayIndexInvalid).
type soapFault struct{ Code int }

func (f soapFault) Error() string { return fmt.Sprintf("UPnP error %d", f.Code) }

func soapCall(ctx context.Context, client *http.Client, controlURL, service, action, args string) (map[string]string, error) {
	body := `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
		`<u:` + action + ` xmlns:u="` + service + `">` + args + `</u:` + action + `></s:Body></s:Envelope>`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, controlURL, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", `text/xml; charset="utf-8"`)
	req.Header.Set("SOAPAction", `"`+service+"#"+action+`"`)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, soapResponseSize))
	fields := ParseSOAPFields(raw)
	if resp.StatusCode != http.StatusOK {
		if code, err := strconv.Atoi(fields["errorCode"]); err == nil {
			return nil, soapFault{Code: code}
		}
		return nil, fmt.Errorf("HTTP %d from the gateway", resp.StatusCode)
	}
	return fields, nil
}

// ParseSOAPFields flattens the leaf elements of a SOAP response into name → text.
func ParseSOAPFields(raw []byte) map[string]string {
	out := map[string]string{}
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var stack []string
	var text strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			return out
		}
		switch t := tok.(type) {
		case xml.StartElement:
			stack = append(stack, t.Name.Local)
			text.Reset()
		case xml.CharData:
			if text.Len() < 1024 {
				text.Write(t)
			}
		case xml.EndElement:
			if len(stack) > 0 {
				name := stack[len(stack)-1]
				if _, exists := out[name]; !exists {
					out[name] = strings.TrimSpace(text.String())
				}
				stack = stack[:len(stack)-1]
			}
			text.Reset()
		}
	}
}

// MappingFromFields turns a GetGenericPortMappingEntry response into a mapping. ok=false for
// entries that cannot be reported faithfully (unknown protocol, a non-IPv4 internal client).
func MappingFromFields(f map[string]string) (UPnPMapping, bool) {
	proto := strings.ToUpper(strings.TrimSpace(f["NewProtocol"]))
	ext, err1 := strconv.Atoi(f["NewExternalPort"])
	in, err2 := strconv.Atoi(f["NewInternalPort"])
	client, err3 := netip.ParseAddr(strings.TrimSpace(f["NewInternalClient"]))
	if (proto != "TCP" && proto != "UDP") || err1 != nil || err2 != nil || err3 != nil || !client.Is4() || ext < 0 || ext > 65535 || in < 0 || in > 65535 {
		return UPnPMapping{}, false
	}
	m := UPnPMapping{
		Protocol:       proto,
		ExternalPort:   ext,
		RemoteHost:     cleanText(f["NewRemoteHost"], 64),
		InternalClient: client.String(),
		InternalPort:   in,
		Description:    cleanText(f["NewPortMappingDescription"], 120),
		Enabled:        f["NewEnabled"] != "0" && !strings.EqualFold(f["NewEnabled"], "false"),
	}
	if l, err := strconv.ParseUint(strings.TrimSpace(f["NewLeaseDuration"]), 10, 32); err == nil {
		v := uint32(l)
		m.LeaseSeconds = &v
	}
	return m, true
}

// AuditGateway reads one gateway's description, external address and port mappings.
func AuditGateway(ctx context.Context, address, location string, client *http.Client) UPnPGateway {
	gw := UPnPGateway{Address: address, Mappings: []UPnPMapping{}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		gw.Error = "invalid description URL"
		return gw
	}
	resp, err := client.Do(req)
	if err != nil {
		gw.Error = cleanText("could not read the device description: "+err.Error(), 300)
		return gw
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxDescription))
	resp.Body.Close()
	desc, err := ParseIGDDescription(body, location)
	gw.FriendlyName, gw.Manufacturer, gw.Model = desc.FriendlyName, desc.Manufacturer, desc.Model
	if err != nil {
		gw.Error = cleanText(err.Error(), 300)
		return gw
	}
	// The control URL must stay on the gateway that answered.
	if cu, err := url.Parse(desc.ControlURL); err != nil || cu.Hostname() != address || (cu.Scheme != "http" && cu.Scheme != "https") {
		gw.Error = "the control URL points away from the gateway; not followed"
		return gw
	}
	gw.ServiceType = desc.ServiceType
	if f, err := soapCall(ctx, client, desc.ControlURL, desc.ServiceType, "GetExternalIPAddress", ""); err == nil {
		if ip, err := netip.ParseAddr(strings.TrimSpace(f["NewExternalIPAddress"])); err == nil && ip.Is4() {
			gw.ExternalIP = ip.String()
		}
	}
	for i := 0; ; i++ {
		if i >= maxMappings {
			gw.MappingsTruncated = true
			break
		}
		f, err := soapCall(ctx, client, desc.ControlURL, desc.ServiceType, "GetGenericPortMappingEntry", "<NewPortMappingIndex>"+strconv.Itoa(i)+"</NewPortMappingIndex>")
		if err != nil {
			var fault soapFault
			// 713 SpecifiedArrayIndexInvalid (and 714 / 402 on some firmwares) marks the end of the list.
			if errors.As(err, &fault) && (fault.Code == 713 || fault.Code == 714 || fault.Code == 402 || fault.Code == 501) {
				break
			}
			if i == 0 && errors.As(err, &fault) && fault.Code == 606 {
				gw.Error = "the gateway refuses to list port mappings (UPnP error 606: action not authorized)"
				break
			}
			if !errors.As(err, &fault) {
				gw.Error = cleanText(fmt.Sprintf("listing stopped at entry %d: %s", i, err.Error()), 300)
			}
			break
		}
		if m, ok := MappingFromFields(f); ok {
			gw.Mappings = append(gw.Mappings, m)
		}
	}
	sort.SliceStable(gw.Mappings, func(i, j int) bool { return gw.Mappings[i].ExternalPort < gw.Mappings[j].ExternalPort })
	return gw
}

// AuditUPnP finds the gateways of the authorized networks and audits each one.
func AuditUPnP(ctx context.Context, locals []netip.Addr, allowed []netip.Prefix) []UPnPGateway {
	client := &http.Client{
		Timeout: upnpHTTPTimeout,
		// Redirects are not followed: every request stays on the gateway that answered.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: upnpHTTPTimeout}).DialContext, MaxIdleConnsPerHost: 1},
	}
	found := DiscoverIGD(ctx, locals, allowed)
	addrs := make([]string, 0, len(found))
	for a := range found {
		addrs = append(addrs, a)
	}
	sort.Strings(addrs)
	out := []UPnPGateway{}
	for _, a := range addrs {
		if ctx.Err() != nil {
			break
		}
		out = append(out, AuditGateway(ctx, a, found[a], client))
	}
	return out
}
