package tplink

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
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

type fakeTPLink struct {
	mu      sync.Mutex
	key     *rsa.PrivateKey
	stok    string
	enabled bool
	mode    string
	bl      []blackEntry
	logouts int
	srv     *httptest.Server
}

func newFakeTPLink(t *testing.T) *fakeTPLink {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeTPLink{
		key:     k,
		stok:    "stok-tp-1234",
		enabled: true,
		mode:    "black",
		bl:      []blackEntry{{Key: "k-admin", Name: "AdminBlock", MAC: "AA-BB-CC-00-00-03"}},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTPLink) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeTPLink) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	w.Header().Set("Content-Type", "application/json")
	op := r.FormValue("operation")
	form := r.URL.Query().Get("form")

	if strings.HasPrefix(r.URL.Path, "/cgi-bin/luci/;stok=/login") {
		if op == "read" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"password": []string{fmt.Sprintf("%x", f.key.N), fmt.Sprintf("%x", f.key.E)},
				},
			})
			return
		}
		ct, err := hex.DecodeString(r.FormValue("password"))
		plain, derr := rsa.DecryptPKCS1v15(rand.Reader, f.key, ct)
		if err != nil || derr != nil || string(plain) != "archer-secret" {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errorcode": "login failed"})
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "sysauth", Value: "tp-cookie"})
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]string{"stok": f.stok}})
		return
	}

	prefix := "/cgi-bin/luci/;stok=" + f.stok
	if !strings.HasPrefix(r.URL.Path, prefix) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, prefix)

	switch {
	case rel == "/admin/system" && form == "logout":
		f.logouts++
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	case rel == "/admin/firmware" && form == "upgrade":
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]string{
			"model": "Archer AX53", "firmware_version": "1.2.5 Build 20240510", "hardware_version": "Archer AX53 v1.0",
		}})
	case rel == "/admin/dhcps" && form == "client":
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": []map[string]string{
			{"macaddr": "AA-BB-CC-00-00-01", "ipaddr": "192.168.0.100", "name": "laptop", "leasetime": "01:30:00"},
			{"macaddr": "AA-BB-CC-00-00-03", "ipaddr": "192.168.0.101", "name": "kid-phone", "leasetime": "Permanent"},
		}})
	case rel == "/admin/access_control" && form == "black_devices":
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": []map[string]string{
			{"mac": "AA-BB-CC-00-00-01", "ipaddr": "192.168.0.100", "name": "laptop", "conn_type": "wireless 5G"},
		}})
	case rel == "/admin/access_control" && form == "enable":
		if op == "write" {
			f.enabled = r.FormValue("enable") == "on"
		}
		en := "off"
		if f.enabled {
			en = "on"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]string{"enable": en}})
	case rel == "/admin/access_control" && form == "mode":
		if op == "write" {
			f.mode = r.FormValue("access_mode")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]string{"access_mode": f.mode}})
	case rel == "/admin/access_control" && form == "black_list":
		switch op {
		case "load":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": f.bl})
		case "insert":
			var e blackEntry
			_ = json.Unmarshal([]byte(r.FormValue("new")), &e)
			e.Key = fmt.Sprintf("k-%d", len(f.bl)+1)
			f.bl = append(f.bl, e)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": e})
		case "remove":
			key := r.FormValue("key")
			kept := f.bl[:0]
			for _, e := range f.bl {
				if e.Key != key {
					kept = append(kept, e)
				}
			}
			f.bl = kept
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestTPLink(t *testing.T, f *fakeTPLink, pass string) router.Driver {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	creds := func(context.Context) (string, []byte, error) { return "admin", []byte(pass), nil }
	d, err := router.Open(
		router.Target{ID: "tp1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestTPLinkEndToEnd(t *testing.T) {
	f := newFakeTPLink(t)
	d := openTestTPLink(t, f, "archer-secret")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Model != "Archer AX53" {
		t.Fatalf("info: %+v %v", info, err)
	}
	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 2 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Connection != router.ConnWiFi5 || clients[0].Lease == nil || *clients[0].Lease.Remaining != 90*time.Minute {
		t.Errorf("laptop: %+v", clients[0])
	}
	if clients[1].Lease == nil || clients[1].Lease.Source != "reserved" || clients[1].Blocked == nil || !*clients[1].Blocked {
		t.Errorf("pre-blocked client: %+v", clients[1])
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

func TestTPLinkBadAuth(t *testing.T) {
	f := newFakeTPLink(t)
	d := openTestTPLink(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
