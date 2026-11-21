package huawei

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/router"
)

type fakeHuawei struct {
	mu           sync.Mutex
	saltHex      string
	iterations   int
	firstNonce   string
	serverNonce  string
	loggedIn     bool
	macFilter    macFilterCfg
	logouts      int
	srv          *httptest.Server
}

func newFakeHuawei(t *testing.T) *fakeHuawei {
	t.Helper()
	f := &fakeHuawei{
		saltHex:     "0102030405060708090a0b0c0d0e0f10",
		iterations:  100,
		serverNonce: "servernonce1234567890abcdef",
		macFilter: macFilterCfg{
			Enable:  true,
			Mode:    "Blacklist",
			Entries: []macFilterEntry{{MAC: "AA:BB:CC:00:00:03", Name: "AdminEntry"}},
		},
	}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHuawei) pin() string {
	sum := sha256.Sum256(f.srv.Certificate().Raw)
	return router.FormatPin(sum[:])
}

func (f *fakeHuawei) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch r.URL.Path {
	case "/":
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><meta name="csrf_param" content="p1"/><meta name="csrf_token" content="t1"/></head></html>`))
	case "/api/system/user_login_nonce":
		var req struct {
			Data struct {
				Username   string `json:"username"`
				FirstNonce string `json:"firstnonce"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.firstNonce = req.Data.FirstNonce
		_ = json.NewEncoder(w).Encode(map[string]any{
			"err": 0, "salt": f.saltHex, "iterations": f.iterations,
			"servernonce": f.serverNonce, "csrf_param": "p2", "csrf_token": "t2",
		})
	case "/api/system/user_login_proof":
		var req struct {
			Data struct {
				ClientProof string `json:"clientproof"`
				FinalNonce  string `json:"finalnonce"`
			} `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		want, _ := huaweiClientProof([]byte("we-dg8045-pass"), f.saltHex, f.iterations, f.firstNonce, f.serverNonce)
		if req.Data.ClientProof != want {
			_ = json.NewEncoder(w).Encode(map[string]any{"err": 1, "errorCategory": "user_pass_err"})
			return
		}
		f.loggedIn = true
		http.SetCookie(w, &http.Cookie{Name: "SessionID_R3", Value: "hw-sess-1"})
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p3", "csrf_token": "t3"})
	case "/api/system/user_logout":
		f.logouts++
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0})
	case "/api/system/deviceinfo":
		if !strings.Contains(r.Header.Get("Cookie"), "SessionID_R3=hw-sess-1") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`while(1); /*{"DeviceName":"DG8045","SoftwareVersion":"V100R019C10","HardwareVersion":"VER.B","SerialNumber":"HW2026TEST"}*/`))
	case "/api/system/HostInfo":
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"MACAddress": "AA:BB:CC:00:00:01", "IPAddress": "192.168.1.15", "HostName": "samsung-s24", "Active": true, "InterfaceType": "802.11 5GHz", "SignalStrength": -55, "AddressSource": "DHCP", "LeaseTime": 3600},
			{"MACAddress": "AA:BB:CC:00:00:02", "IPAddress": "192.168.1.16", "HostName": "tv-box", "Active": true, "InterfaceType": "Ethernet", "AddressSource": "DHCP"},
			{"MACAddress": "AA:BB:CC:00:00:03", "IPAddress": "192.168.1.17", "HostName": "blocked-dev", "Active": false, "InterfaceType": "802.11 2.4GHz"},
		})
	case "/api/ntwk/macfilter":
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(f.macFilter)
			return
		}
		var req struct {
			Data macFilterCfg `json:"data"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.macFilter = req.Data
		_ = json.NewEncoder(w).Encode(map[string]any{"err": 0, "csrf_param": "p4", "csrf_token": "t4"})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func openTestHuawei(t *testing.T, f *fakeHuawei, pass string) (router.Driver, *[][]byte) {
	t.Helper()
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(f.srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)
	addr := netip.MustParseAddr(host)
	var given [][]byte
	creds := func(context.Context) (string, []byte, error) {
		b := []byte(pass)
		given = append(given, b)
		return "admin", b, nil
	}
	d, err := router.Open(
		router.Target{ID: "hw1", Vendor: Vendor, Address: addr, Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: f.pin(), Timeout: 5 * time.Second},
		creds,
		router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}, AllowLoopback: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	return d, &given
}

func TestHuaweiEndToEnd(t *testing.T) {
	f := newFakeHuawei(t)
	d, given := openTestHuawei(t, f, "we-dg8045-pass")
	ctx := context.Background()

	info, err := d.Identify(ctx)
	if err != nil || info.Vendor != "Huawei" || info.Model != "DG8045" || info.Firmware != "V100R019C10" {
		t.Fatalf("info: %+v %v", info, err)
	}
	for _, g := range *given {
		for _, b := range g {
			if b != 0 {
				t.Fatal("password was not zeroed")
			}
		}
	}

	clients, err := d.Clients(ctx)
	if err != nil || len(clients) != 3 {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if clients[0].Connection != router.ConnWiFi5 || *clients[0].SignalDBm != -55 || clients[0].Lease == nil {
		t.Errorf("wifi client: %+v", clients[0])
	}
	if clients[2].Blocked == nil || !*clients[2].Blocked {
		t.Errorf("pre-blocked client: %+v", clients[2])
	}

	// Admin entry stays untouched.
	pre, err := d.Block(ctx, "aa:bb:cc:00:00:03")
	if err != nil || pre.Applied || !pre.AlreadyInEffect {
		t.Fatalf("pre-blocked: %+v %v", pre, err)
	}
	unPre, err := d.Unblock(ctx, "aa:bb:cc:00:00:03")
	if err != nil || unPre.Applied {
		t.Fatalf("must not touch admin entry: %+v %v", unPre, err)
	}

	// Managed block & unblock.
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

func TestHuaweiBadAuth(t *testing.T) {
	f := newFakeHuawei(t)
	d, _ := openTestHuawei(t, f, "wrong")
	defer d.Close(context.Background())
	if _, err := d.Identify(context.Background()); !errors.Is(err, router.ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
}
