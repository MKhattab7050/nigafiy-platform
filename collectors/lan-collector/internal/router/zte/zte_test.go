package zte

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

type fakeZTE struct {
	mu      sync.Mutex
	random  string
	nextID  int
	rules   []map[string]string
	logouts int
	srv     *httptest.Server
}

func newFakeZTE(t *testing.T) *fakeZTE {
	t.Helper()
	f := &fakeZTE{
		random: "83719402",
		nextID: 2,
		rules: []map[string]string{
			{"_InstID": "IGD.LD1.MF1", "Enable": "1", "Name": "AdminRule", "MACAddress": "AA:BB:CC:00:00:03"},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeZTE) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeZTE) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	typ := r.URL.Query().Get("_type")
	tag := r.URL.Query().Get("_tag")

	if typ == "loginData" && tag == "login_entry" {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"loginRandom": f.random, "sess_token": "zte-tok-1"})
			return
		}
		sum := sha256.Sum256([]byte("we-h188a-pass" + f.random))
		if r.FormValue("Username") != "admin" || r.FormValue("Password") != hex.EncodeToString(sum[:]) {
			_ = json.NewEncoder(w).Encode(map[string]any{"loginErrMsg": "Invalid username or password"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "SID", Value: "zte-sid-1"})
		_ = json.NewEncoder(w).Encode(map[string]any{"login_need_refresh": 1, "sess_token": "zte-tok-2"})
		return
	}
	if typ == "loginData" && tag == "logout_entry" {
		f.logouts++
		w.WriteHeader(http.StatusOK)
		return
	}
	if !strings.Contains(r.Header.Get("Cookie"), "SID=zte-sid-1") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch tag {
	case "devmgr_statusmgr_lua.lua":
		_, _ = w.Write([]byte(`<ajax_response_xml_root><OBJ_DEVINFO_ID><Instance>
			<ParaName>ModelName</ParaName><ParaValue>ZXHN H188A</ParaValue>
			<ParaName>SoftwareVer</ParaName><ParaValue>V1.0.0P1T2_EG</ParaValue>
			<ParaName>SerialNumber</ParaName><ParaValue>ZTEWE12345</ParaValue>
		</Instance></OBJ_DEVINFO_ID></ajax_response_xml_root>`))
	case "accessdev_landev_lua.lua":
		_, _ = w.Write([]byte(`<ajax_response_xml_root><OBJ_ACCESSDEV_ID>
			<Instance>
				<ParaName>MACAddress</ParaName><ParaValue>AA:BB:CC:00:00:01</ParaValue>
				<ParaName>IPAddress</ParaName><ParaValue>192.168.1.30</ParaValue>
				<ParaName>HostName</ParaName><ParaValue>ahmed-phone</ParaValue>
				<ParaName>InterfaceType</ParaName><ParaValue>WLAN 5G</ParaValue>
				<ParaName>RSSI</ParaName><ParaValue>-59</ParaValue>
				<ParaName>LeaseTime</ParaName><ParaValue>7200</ParaValue>
				<ParaName>Active</ParaName><ParaValue>1</ParaValue>
			</Instance>
			<Instance>
				<ParaName>MACAddress</ParaName><ParaValue>AA:BB:CC:00:00:03</ParaValue>
				<ParaName>IPAddress</ParaName><ParaValue>192.168.1.31</ParaValue>
				<ParaName>HostName</ParaName><ParaValue>blocked-pc</ParaValue>
				<ParaName>InterfaceType</ParaName><ParaValue>LAN1</ParaValue>
				<ParaName>Active</ParaName><ParaValue>1</ParaValue>
			</Instance>
		</OBJ_ACCESSDEV_ID></ajax_response_xml_root>`))
	case "localnet_macfilter_lua.lua":
		if r.Method == http.MethodPost {
			switch r.FormValue("IF_ACTION") {
			case "Apply":
				f.nextID++
				f.rules = append(f.rules, map[string]string{
					"_InstID":    fmt.Sprintf("IGD.LD1.MF%d", f.nextID),
					"Enable":     "1",
					"Name":       r.FormValue("Name"),
					"MACAddress": r.FormValue("MACAddress"),
				})
			case "Delete":
				id := r.FormValue("_InstID")
				kept := f.rules[:0]
				for _, rule := range f.rules {
					if rule["_InstID"] != id {
						kept = append(kept, rule)
					}
				}
				f.rules = kept
			}
			_, _ = w.Write([]byte(`<ajax_response_xml_root><IF_ERRORSTR>SUCC</IF_ERRORSTR></ajax_response_xml_root>`))
			return
		}
		var b strings.Builder
		b.WriteString(`<ajax_response_xml_root><OBJ_MF><Instance><ParaName>FilterMode</ParaName><ParaValue>Black</ParaValue></Instance>`)
		for _, rule := range f.rules {
			b.WriteString(`<Instance>`)
			for k, v := range rule {
				fmt.Fprintf(&b, `<ParaName>%s</ParaName><ParaValue>%s</ParaValue>`, k, v)
			}
			b.WriteString(`</Instance>`)
		}
		b.WriteString(`</OBJ_MF></ajax_response_xml_root>`)
		_, _ = w.Write([]byte(b.String()))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestZTE(t *testing.T, f *fakeZTE, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "zt1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestZTEEndToEnd(t *testing.T) {
	f := newFakeZTE(t)
	d := openTestZTE(t, f, "we-h188a-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "ZTE" || info.Model != "ZXHN H188A" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Connection != router.ConnWiFi5 || *clients[0].SignalDBm != -59 {
		t.Errorf("wifi client: %+v", clients[0])
	}
	if clients[1].Blocked == nil || !*clients[1].Blocked {
		t.Errorf("admin blocked client: %+v", clients[1])
	}

	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-blocked: %+v %v", pre, err)
	}
	unPre, err := d.Unblock(ctx, "aa:bb:cc:00:00:03")
	if err != nil || unPre.Applied {
		t.Fatalf("must not touch admin rule: %+v %v", unPre, err)
	}

	ch, err := d.Block(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !ch.Applied {
		t.Fatalf("block: %+v %v", ch, err)
	}
	un, err := d.Unblock(ctx, "aa:bb:cc:00:00:01")
	if err != nil || !un.Applied {
		t.Fatalf("unblock: %+v %v", un, err)
	}
	if err := d.Close(ctx); err != nil || f.logouts != 1 {
		t.Fatalf("close: %v logouts=%d", err, f.logouts)
	}
}

func TestZTEBadAuth(t *testing.T) {
	f := newFakeZTE(t)
	d := openTestZTE(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
