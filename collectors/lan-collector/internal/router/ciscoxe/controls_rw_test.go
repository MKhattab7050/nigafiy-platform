package ciscoxe

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/router"
)

// iosxe is a stateful protocol test double of the IOS XE RESTCONF paths the controls use, over TLS
// with its own certificate (pinned by the driver). It keeps the configuration as decoded JSON, applies
// PUT / PATCH / DELETE like the device (one request = one transaction) and counts save-config RPCs.
// Faults: unknown models (an older release), refused paths, administrator ACLs and policies.
type iosxe struct {
	mu       sync.Mutex
	version  string
	ifaces   map[string]map[string]any // "GigabitEthernet=0/0/1" → interface object
	acls     map[string]any            // name → extended ACL object
	tr       map[string]any
	cmaps    map[string]any
	pmaps    map[string]map[string]any // policy → class → class object
	pools    map[string]map[string]any
	nat      []map[string]any
	saves    int
	writes   []string
	unknown  map[string]bool // path prefix → "unknown-element" (model missing on this release)
	reject   map[string]bool // path prefix → HTTP 400 invalid-value
	noSaveOK bool
	srv      *httptest.Server
}

const lanIfKey = "GigabitEthernet=0/0/1"

func newIOSXE(t *testing.T) *iosxe {
	x := &iosxe{
		version: "17.9.4a",
		ifaces: map[string]map[string]any{
			lanIfKey: {"name": "0/0/1", "ip": map[string]any{"address": map[string]any{"primary": map[string]any{"address": "192.168.88.1", "mask": "255.255.255.0"}}, "Cisco-IOS-XE-nat:nat": map[string]any{"inside": []any{nil}}}},
			"GigabitEthernet=0/0/0": {"name": "0/0/0", "ip": map[string]any{"address": map[string]any{"primary": map[string]any{"address": "41.20.30.40", "mask": "255.255.255.252"}}, "Cisco-IOS-XE-nat:nat": map[string]any{"outside": []any{nil}}}},
		},
		acls: map[string]any{}, tr: map[string]any{}, cmaps: map[string]any{}, pmaps: map[string]map[string]any{}, pools: map[string]map[string]any{},
		unknown: map[string]bool{}, reject: map[string]bool{},
	}
	x.srv = httptest.NewTLSServer(http.HandlerFunc(x.serve))
	t.Cleanup(x.srv.Close)
	return x
}

func (x *iosxe) driver(t *testing.T) *Driver {
	t.Helper()
	host, pStr, _ := net.SplitHostPort(x.srv.Listener.Addr().String())
	port, _ := strconv.Atoi(pStr)
	sum := sha256.Sum256(x.srv.Certificate().Raw)
	d, err := New(router.Target{ID: "cx", Vendor: Vendor, Address: netip.MustParseAddr(host), Port: port, Transport: router.TransportHTTPSPinned, PinSHA256: router.FormatPin(sum[:]), Timeout: 5 * time.Second},
		func(context.Context) (string, []byte, error) { return "admin", []byte(cxPassword), nil })
	if err != nil {
		t.Fatal(err)
	}
	d.lanAddr = netip.MustParseAddr("192.168.88.1")
	t.Cleanup(func() { _ = d.Close(context.Background()) })
	return d
}

func rcErr(w http.ResponseWriter, st int, tag, msg string) {
	w.WriteHeader(st)
	_ = json.NewEncoder(w).Encode(map[string]any{"ietf-restconf:errors": map[string]any{"error": []any{map[string]any{"error-tag": tag, "error-message": msg}}}})
}

func one(body map[string]any, key string) map[string]any {
	switch v := body[key].(type) {
	case []any:
		if len(v) > 0 {
			m, _ := v[0].(map[string]any)
			return m
		}
	case map[string]any:
		return v
	}
	return nil
}

func merge(dst, src map[string]any) {
	for k, v := range src {
		if sm, ok := v.(map[string]any); ok {
			if dm, ok := dst[k].(map[string]any); ok {
				merge(dm, sm)
				continue
			}
		}
		dst[k] = v
	}
}

func (x *iosxe) serve(w http.ResponseWriter, r *http.Request) {
	if u, p, ok := r.BasicAuth(); !ok || u != "admin" || p != cxPassword {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	path := r.URL.EscapedPath()
	if p, err := url.PathUnescape(path); err == nil {
		path = p
	}
	rest := strings.TrimPrefix(path, nativePath)
	var body map[string]any
	if r.Body != nil {
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
	}
	if r.Method != http.MethodGet {
		x.writes = append(x.writes, r.Method+" "+rest)
		for pre := range x.unknown {
			if strings.HasPrefix(rest, pre) {
				rcErr(w, http.StatusBadRequest, "unknown-element", "unknown element in this release")
				return
			}
		}
		for pre := range x.reject {
			if strings.HasPrefix(rest, pre) {
				rcErr(w, http.StatusBadRequest, "invalid-value", "inconsistent value: policer not supported on this interface")
				return
			}
		}
	}
	enc := json.NewEncoder(w)
	switch {
	case path == "/restconf/data/Cisco-IOS-XE-native:native/version":
		_ = enc.Encode(map[string]any{"Cisco-IOS-XE-native:version": x.version})
	case path == "/restconf/data/Cisco-IOS-XE-arp-oper:arp-data":
		_ = enc.Encode(map[string]any{"Cisco-IOS-XE-arp-oper:arp-data": map[string]any{"arp-entry": []any{
			map[string]any{"ip-address": "192.168.88.15", "hw-address": "aabb.cc00.0300", "interface": "GigabitEthernet0/0/1"},
			map[string]any{"ip-address": "192.168.88.16", "hw-address": "aabb.cc00.0400", "interface": "GigabitEthernet0/0/1"},
		}}})
	case path == saveRPC && r.Method == http.MethodPost:
		if x.noSaveOK {
			rcErr(w, http.StatusInternalServerError, "operation-failed", "save failed")
			return
		}
		x.saves++
		_ = enc.Encode(map[string]any{"cisco-ia:output": map[string]any{"result": "Save running config successful"}})
	case rest == "/interface" && r.Method == http.MethodGet:
		types := map[string][]any{}
		for k, v := range x.ifaces {
			typ := strings.SplitN(k, "=", 2)[0]
			types[typ] = append(types[typ], v)
		}
		_ = enc.Encode(map[string]any{"Cisco-IOS-XE-native:interface": types})
	case strings.HasPrefix(rest, "/interface/") && r.Method == http.MethodPatch:
		key := strings.TrimPrefix(rest, "/interface/")
		cur, ok := x.ifaces[key]
		obj := one(body, "Cisco-IOS-XE-native:"+strings.SplitN(key, "=", 2)[0])
		if !ok || obj == nil {
			rcErr(w, http.StatusBadRequest, "invalid-value", "bad interface")
			return
		}
		merge(cur, obj)
		w.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(rest, "/ip/access-list/Cisco-IOS-XE-acl:extended="):
		name := strings.TrimPrefix(rest, "/ip/access-list/Cisco-IOS-XE-acl:extended=")
		switch r.Method {
		case http.MethodGet:
			if a, ok := x.acls[name]; ok {
				_ = enc.Encode(map[string]any{"Cisco-IOS-XE-acl:extended": []any{a}})
			} else {
				rcErr(w, http.StatusNotFound, "invalid-value", "uri keypath not found")
			}
		case http.MethodPut:
			x.acls[name] = one(body, "Cisco-IOS-XE-acl:extended")
			w.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			if _, ok := x.acls[name]; !ok {
				rcErr(w, http.StatusNotFound, "invalid-value", "not found")
				return
			}
			delete(x.acls, name)
			w.WriteHeader(http.StatusNoContent)
		}
	case strings.HasPrefix(rest, "/time-range="):
		name := strings.TrimPrefix(rest, "/time-range=")
		switch r.Method {
		case http.MethodPut:
			x.tr[name] = one(body, "Cisco-IOS-XE-native:time-range")
			w.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			if _, ok := x.tr[name]; !ok {
				rcErr(w, http.StatusNotFound, "invalid-value", "not found")
				return
			}
			delete(x.tr, name)
			w.WriteHeader(http.StatusNoContent)
		}
	case strings.HasPrefix(rest, "/policy/Cisco-IOS-XE-policy:class-map="):
		name := strings.TrimPrefix(rest, "/policy/Cisco-IOS-XE-policy:class-map=")
		if r.Method == http.MethodPut {
			x.cmaps[name] = one(body, "Cisco-IOS-XE-policy:class-map")
			w.WriteHeader(http.StatusNoContent)
		} else if _, ok := x.cmaps[name]; ok {
			delete(x.cmaps, name)
			w.WriteHeader(http.StatusNoContent)
		} else {
			rcErr(w, http.StatusNotFound, "invalid-value", "not found")
		}
	case strings.HasPrefix(rest, "/policy/Cisco-IOS-XE-policy:policy-map="):
		pm := strings.TrimPrefix(rest, "/policy/Cisco-IOS-XE-policy:policy-map=")
		class := ""
		if i := strings.Index(pm, "/class="); i >= 0 {
			pm, class = pm[:i], pm[i+len("/class="):]
		}
		switch r.Method {
		case http.MethodGet:
			cs, ok := x.pmaps[pm]
			if !ok {
				rcErr(w, http.StatusNotFound, "invalid-value", "not found")
				return
			}
			list := []any{}
			for _, c := range cs {
				list = append(list, c)
			}
			_ = enc.Encode(map[string]any{"Cisco-IOS-XE-policy:policy-map": []any{map[string]any{"name": pm, "class": list}}})
		case http.MethodPatch:
			obj := one(body, "Cisco-IOS-XE-policy:policy-map")
			if x.pmaps[pm] == nil {
				x.pmaps[pm] = map[string]any{}
			}
			for _, c := range obj["class"].([]any) {
				cm := c.(map[string]any)
				x.pmaps[pm][cm["name"].(string)] = cm
			}
			w.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			if _, ok := x.pmaps[pm][class]; !ok {
				rcErr(w, http.StatusNotFound, "invalid-value", "not found")
				return
			}
			delete(x.pmaps[pm], class)
			w.WriteHeader(http.StatusNoContent)
		}
	case rest == "/ip/Cisco-IOS-XE-dhcp:dhcp" && r.Method == http.MethodGet:
		list := []any{}
		for _, p := range x.pools {
			list = append(list, p)
		}
		_ = enc.Encode(map[string]any{"Cisco-IOS-XE-dhcp:dhcp": map[string]any{"pool": list}})
	case strings.HasPrefix(rest, "/ip/Cisco-IOS-XE-dhcp:dhcp/pool="):
		name := strings.TrimPrefix(rest, "/ip/Cisco-IOS-XE-dhcp:dhcp/pool=")
		switch r.Method {
		case http.MethodPut:
			x.pools[name] = one(body, "Cisco-IOS-XE-dhcp:pool")
		case http.MethodPatch:
			merge(x.pools[name], one(body, "Cisco-IOS-XE-dhcp:pool"))
		case http.MethodDelete:
			delete(x.pools, name)
		}
		w.WriteHeader(http.StatusNoContent)
	case rest == "/ip/Cisco-IOS-XE-nat:nat":
		switch r.Method {
		case http.MethodGet:
			list := make([]any, 0, len(x.nat))
			for _, e := range x.nat {
				list = append(list, e)
			}
			_ = enc.Encode(map[string]any{"Cisco-IOS-XE-nat:nat": map[string]any{"inside": map[string]any{"source": map[string]any{"static": map[string]any{natList: list}}}}})
		case http.MethodPatch:
			st := body["Cisco-IOS-XE-nat:nat"].(map[string]any)["inside"].(map[string]any)["source"].(map[string]any)["static"].(map[string]any)[natList].([]any)
			for _, e := range st {
				x.nat = append(x.nat, e.(map[string]any))
			}
			w.WriteHeader(http.StatusNoContent)
		}
	case strings.HasPrefix(rest, "/ip/Cisco-IOS-XE-nat:nat/inside/source/static/"+natList+"=") && r.Method == http.MethodDelete:
		keys := strings.Split(strings.TrimPrefix(rest, "/ip/Cisco-IOS-XE-nat:nat/inside/source/static/"+natList+"="), ",")
		out := x.nat[:0]
		for _, e := range x.nat {
			k := []string{jsonScalar(e["proto"]), jsonScalar(e["local-ip"]), jsonScalar(e["local-port"]), jsonScalar(e["global-ip"]), jsonScalar(e["global-port"])}
			if strings.Join(k, ",") != strings.Join(keys, ",") {
				out = append(out, e)
			}
		}
		x.nat = out
		w.WriteHeader(http.StatusNoContent)
	default:
		rcErr(w, http.StatusNotFound, "invalid-value", "uri keypath not found")
	}
}

func (x *iosxe) lanField(path ...string) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	var cur any = x.ifaces[lanIfKey]
	for _, p := range path {
		m, _ := cur.(map[string]any)
		cur = m[p]
	}
	s, _ := cur.(string)
	return s
}

const macA = "aa:bb:cc:00:03:00"

func TestIOSXEBlockUnblockOverACL(t *testing.T) {
	x := newIOSXE(t)
	d := x.driver(t)
	ctx := context.Background()
	caps, err := d.Capabilities(ctx)
	if err != nil || !caps.Supports(router.CapBlock) || !caps.Supports(router.CapSchedule) || !caps.Supports(router.CapRateLimit) ||
		!caps.Supports(router.CapReservations) || !caps.Supports(router.CapPortForward) || !caps.Supports(router.CapRename) || caps.Supports(router.CapWiFi) {
		t.Fatalf("caps: %+v %v", caps, err)
	}
	if caps.Get(router.CapRename).Requires != router.RequiresReservation || caps.Get(router.CapWiFi).Note != noteWiFi {
		t.Fatalf("rename must require a reservation, Wi-Fi must say why: %+v", caps)
	}

	ch, err := d.Block(ctx, macA)
	if err != nil || !ch.Applied || ch.AlreadyInEffect || ch.Undo == "" {
		t.Fatalf("block: %+v %v", ch, err)
	}
	if x.lanField("ip", "access-group", "in", "acl", "acl-name") != aclName || x.saves != 1 {
		t.Fatalf("ACL must be attached inbound and saved once: saves=%d writes=%v", x.saves, x.writes)
	}
	// The ACL was written before it was attached, and it ends with permit ip any any.
	if x.writes[0] != "PUT /ip/access-list/Cisco-IOS-XE-acl:extended="+aclName || !strings.HasPrefix(x.writes[1], "PATCH /interface/") {
		t.Fatalf("order of writes: %v", x.writes)
	}
	raw, _ := json.Marshal(x.acls[aclName])
	if !strings.Contains(string(raw), `"host":"192.168.88.15"`) || !strings.Contains(string(raw), `"sequence":"2147483000"`) {
		t.Fatalf("ACL: %s", raw)
	}
	bl, err := d.Blocked(ctx)
	if err != nil || len(bl) != 1 || bl[0].MAC != macA || bl[0].Owner != router.OwnerProduct || !bl[0].Managed {
		t.Fatalf("blocked: %+v %v", bl, err)
	}
	cs, _ := d.Clients(ctx)
	for _, c := range cs {
		if c.Blocked == nil || *c.Blocked != (c.MAC == macA) {
			t.Fatalf("client block state: %+v", c)
		}
	}
	again, err := d.Block(ctx, macA)
	if err != nil || again.Applied || !again.AlreadyInEffect || x.saves != 1 {
		t.Fatalf("block twice: %+v %v saves=%d", again, err, x.saves)
	}
	un, err := d.Unblock(ctx, macA)
	if err != nil || !un.Applied || x.saves != 2 {
		t.Fatalf("unblock: %+v %v", un, err)
	}
	if bl, _ := d.Blocked(ctx); len(bl) != 0 {
		t.Fatalf("still blocked: %+v", bl)
	}
	if un, err := d.Unblock(ctx, macA); err != nil || un.Applied {
		t.Fatalf("unblock twice: %+v %v", un, err)
	}
	if _, err := d.Block(ctx, "aa:bb:cc:00:09:09"); !errors.Is(err, router.ErrNotFound) {
		t.Fatalf("unknown device: want ErrNotFound, got %v", err)
	}
}

func TestIOSXERefusesTheAdministratorsACLAndOldReleases(t *testing.T) {
	ctx := context.Background()
	t.Run("administrator ACL on the LAN", func(t *testing.T) {
		x := newIOSXE(t)
		x.ifaces[lanIfKey]["ip"].(map[string]any)["access-group"] = map[string]any{"in": map[string]any{"acl": map[string]any{"acl-name": "CORP-IN", "in": []any{nil}}}}
		d := x.driver(t)
		caps, _ := d.Capabilities(ctx)
		if caps.Supports(router.CapBlock) || !strings.Contains(caps.Get(router.CapBlock).Note, "CORP-IN") {
			t.Fatalf("block must be refused with the reason: %+v", caps.Get(router.CapBlock))
		}
		if _, err := d.Block(ctx, macA); !errors.Is(err, router.ErrRejected) || len(x.writes) != 0 {
			t.Fatalf("want ErrRejected and no write, got %v %v", err, x.writes)
		}
	})
	t.Run("IOS XE 16.3 has no RESTCONF configuration writes", func(t *testing.T) {
		x := newIOSXE(t)
		x.version = "16.3.7"
		d := x.driver(t)
		caps, _ := d.Capabilities(ctx)
		for _, c := range []router.Capability{router.CapBlock, router.CapRateLimit, router.CapSchedule, router.CapReservations, router.CapPortForward, router.CapRename} {
			if caps.Supports(c) || !strings.Contains(caps.Get(c).Note, "16.6") {
				t.Fatalf("%s: %+v", c, caps.Get(c))
			}
		}
		if _, err := d.AddReservation(ctx, macA, "192.168.88.50"); !errors.Is(err, router.ErrUnsupported) || len(x.writes) != 0 {
			t.Fatalf("want ErrUnsupported, got %v %v", err, x.writes)
		}
	})
	t.Run("a release without the time-range model", func(t *testing.T) {
		x := newIOSXE(t)
		x.unknown["/time-range="] = true
		d := x.driver(t)
		_, err := d.SetSchedule(ctx, macA, []router.Window{{Days: []time.Weekday{time.Monday}, Start: "22:00", End: "06:00"}})
		if !errors.Is(err, router.ErrUnsupported) || !strings.Contains(err.Error(), "time ranges") || x.saves != 0 || len(x.acls) != 0 {
			t.Fatalf("want ErrUnsupported naming the feature, nothing changed: %v saves=%d", err, x.saves)
		}
	})
	t.Run("save fails: reported, not hidden", func(t *testing.T) {
		x := newIOSXE(t)
		x.noSaveOK = true
		d := x.driver(t)
		if _, err := d.Block(ctx, macA); !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "write memory") {
			t.Fatalf("want the save failure, got %v", err)
		}
	})
}

func TestIOSXEScheduleAcrossMidnight(t *testing.T) {
	x := newIOSXE(t)
	d := x.driver(t)
	ctx := context.Background()
	ch, err := d.SetSchedule(ctx, macA, []router.Window{{Days: []time.Weekday{time.Friday}, Start: "22:00", End: "06:00"}})
	if err != nil || !ch.Applied {
		t.Fatalf("schedule: %+v %v", ch, err)
	}
	name := timeRangeName(macA)
	raw, _ := json.Marshal(x.tr[name])
	if !strings.Contains(string(raw), `{"days":"Friday","end":"23:59","start":"22:00"}`) || !strings.Contains(string(raw), `{"days":"Saturday","end":"06:00","start":"00:00"}`) {
		t.Fatalf("time-range: %s", raw)
	}
	acl, _ := json.Marshal(x.acls[aclName])
	if !strings.Contains(string(acl), `"time-range":"`+name+`"`) {
		t.Fatalf("ACL entry must use the time-range: %s", acl)
	}
	bl, _ := d.Blocked(ctx)
	if len(bl) != 1 || !bl[0].Partial {
		t.Fatalf("a schedule is a partial block: %+v", bl)
	}
	if _, err := d.ClearSchedule(ctx, macA); err != nil {
		t.Fatal(err)
	}
	if _, ok := x.tr[name]; ok {
		t.Fatal("the time-range must be removed")
	}
	if bl, _ := d.Blocked(ctx); len(bl) != 0 {
		t.Fatalf("schedule entry left: %+v", bl)
	}
}

func TestIOSXERateLimit(t *testing.T) {
	x := newIOSXE(t)
	d := x.driver(t)
	ctx := context.Background()
	ch, err := d.SetRateLimit(ctx, macA, router.RateLimit{DownKbps: 4000, UpKbps: 1000})
	if err != nil || !ch.Applied || x.saves != 1 {
		t.Fatalf("rate limit: %+v %v", ch, err)
	}
	if x.lanField("Cisco-IOS-XE-policy:service-policy", "input") != policyIn || x.lanField("Cisco-IOS-XE-policy:service-policy", "output") != policyOut {
		t.Fatalf("policies must be on the LAN interface: %+v", x.ifaces[lanIfKey])
	}
	rates, _ := d.policeRates(ctx, "t", policyOut)
	if rates[rlName(macA, "DN")] != 4_000_000 {
		t.Fatalf("download police: %v", rates)
	}
	// Download only: the upload class goes away.
	if _, err := d.SetRateLimit(ctx, macA, router.RateLimit{DownKbps: 2000}); err != nil {
		t.Fatal(err)
	}
	if _, ok := x.pmaps[policyIn][rlName(macA, "UP")]; ok {
		t.Fatal("the upload class must be removed")
	}
	if _, err := d.ClearRateLimit(ctx, macA); err != nil {
		t.Fatal(err)
	}
	if len(x.pmaps[policyOut]) != 0 || len(x.cmaps) != 0 || len(x.acls) != 0 {
		t.Fatalf("everything of this device must be gone: %v %v %v", x.pmaps, x.cmaps, x.acls)
	}

	t.Run("platform refuses the output policy: the half-made class is removed", func(t *testing.T) {
		x := newIOSXE(t)
		x.reject["/interface/"] = true
		d := x.driver(t)
		_, err := d.SetRateLimit(ctx, macA, router.RateLimit{UpKbps: 1000})
		if !errors.Is(err, router.ErrRejected) || !strings.Contains(err.Error(), "policer") || x.saves != 0 {
			t.Fatalf("want the router's refusal, got %v", err)
		}
		if len(x.pmaps[policyIn]) != 0 || len(x.cmaps) != 0 || len(x.acls) != 0 {
			t.Fatalf("nothing may stay behind: %v %v %v", x.pmaps, x.cmaps, x.acls)
		}
	})
	t.Run("administrator's service policy", func(t *testing.T) {
		x := newIOSXE(t)
		x.ifaces[lanIfKey]["Cisco-IOS-XE-policy:service-policy"] = map[string]any{"output": "CORP-QOS"}
		d := x.driver(t)
		if _, err := d.SetRateLimit(ctx, macA, router.RateLimit{DownKbps: 1000}); !errors.Is(err, router.ErrRejected) || len(x.writes) != 0 {
			t.Fatalf("want ErrRejected and no write, got %v %v", err, x.writes)
		}
	})
}

func TestIOSXEReservationAndRename(t *testing.T) {
	x := newIOSXE(t)
	d := x.driver(t)
	ctx := context.Background()
	if _, err := d.RenameClient(ctx, macA, "printer-2"); !errors.Is(err, router.ErrNotFound) {
		t.Fatalf("rename without a reservation: want ErrNotFound, got %v", err)
	}
	ch, err := d.AddReservation(ctx, macA, "192.168.88.50")
	if err != nil || !ch.Applied || x.saves != 1 {
		t.Fatalf("reserve: %+v %v", ch, err)
	}
	p := x.pools[poolName(macA)]
	raw, _ := json.Marshal(p)
	if !strings.Contains(string(raw), `"unique-identifier":"01aabb.cc00.0300"`) || !strings.Contains(string(raw), `"mask":"255.255.255.0"`) {
		t.Fatalf("pool: %s", raw)
	}
	s, _ := d.Settings(ctx)
	if len(s.Reservations) != 1 || s.Reservations[0].MAC != macA || s.Reservations[0].IP != "192.168.88.50" {
		t.Fatalf("settings reservations: %+v", s.Reservations)
	}
	if _, err := d.AddReservation(ctx, "aa:bb:cc:00:04:00", "192.168.88.50"); !errors.Is(err, router.ErrInvalidArgument) {
		t.Fatalf("an address reserved for another MAC: want ErrInvalidArgument, got %v", err)
	}
	if _, err := d.RenameClient(ctx, macA, "bad name"); !errors.Is(err, router.ErrInvalidArgument) {
		t.Fatalf("a name with a space: want ErrInvalidArgument, got %v", err)
	}
	rn, err := d.RenameClient(ctx, macA, "printer-2")
	if err != nil || !rn.Applied || x.pools[poolName(macA)]["client-name"] != "printer-2" {
		t.Fatalf("rename: %+v %v", rn, err)
	}
	// The administrator's pool for another device is listed, never changed.
	x.pools["CORP-CAM"] = map[string]any{"id": "CORP-CAM", "host": map[string]any{"host": "192.168.88.60", "mask": "255.255.255.0"}, "hardware-address": map[string]any{"hardware-address": "aabb.cc00.0400"}}
	if _, err := d.RemoveReservation(ctx, "aa:bb:cc:00:04:00"); !errors.Is(err, router.ErrRejected) {
		t.Fatalf("admin pool: want ErrRejected, got %v", err)
	}
	if _, err := d.RenameClient(ctx, "aa:bb:cc:00:04:00", "cam"); !errors.Is(err, router.ErrNotFound) {
		t.Fatalf("rename on the admin pool: want ErrNotFound, got %v", err)
	}
	un, err := d.RemoveReservation(ctx, macA)
	if err != nil || !un.Applied {
		t.Fatalf("unreserve: %+v %v", un, err)
	}
	if _, ok := x.pools[poolName(macA)]; ok {
		t.Fatal("pool left behind")
	}
}

func TestIOSXEPortForward(t *testing.T) {
	x := newIOSXE(t)
	d := x.driver(t)
	ctx := context.Background()
	ch, err := d.AddPortForward(ctx, router.PortForward{Protocol: "both", ExternalStart: 8443, InternalStart: 443, InternalIP: "192.168.88.15", Description: "nas"})
	if err != nil || !ch.Applied {
		t.Fatalf("add: %+v %v", ch, err)
	}
	if len(x.nat) != 2 || jsonScalar(x.nat[0]["global-ip"]) != "41.20.30.40" {
		t.Fatalf("both = a tcp and a udp entry on the outside address: %v", x.nat)
	}
	s, _ := d.Settings(ctx)
	if len(s.PortForwards) != 1 || s.PortForwards[0].Protocol != router.ProtoBoth || s.PortForwards[0].ExternalStart != 8443 {
		t.Fatalf("settings: %+v", s.PortForwards)
	}
	for _, bad := range []router.PortForward{
		{Protocol: "tcp", ExternalStart: 9000, ExternalEnd: 9010, InternalIP: "192.168.88.15"}, // a range
		{Protocol: "tcp", ExternalStart: 22, InternalIP: "192.168.88.15"},                      // management port
		{Protocol: "tcp", ExternalStart: 8443, InternalIP: "192.168.88.16"},                    // overlaps
	} {
		if _, err := d.AddPortForward(ctx, bad); !errors.Is(err, router.ErrInvalidArgument) {
			t.Fatalf("%+v: want ErrInvalidArgument, got %v", bad, err)
		}
	}
	seen := s.PortForwards[0]
	changed := seen
	changed.InternalStart, changed.InternalEnd = 444, 444
	if _, err := d.RemovePortForward(ctx, changed); !errors.Is(err, router.ErrRejected) {
		t.Fatalf("a changed rule: want ErrRejected, got %v", err)
	}
	if rm, err := d.RemovePortForward(ctx, seen); err != nil || !rm.Applied || len(x.nat) != 0 {
		t.Fatalf("remove: %+v %v %v", rm, err, x.nat)
	}

	t.Run("no NAT on the router", func(t *testing.T) {
		x := newIOSXE(t)
		delete(x.ifaces[lanIfKey]["ip"].(map[string]any), "Cisco-IOS-XE-nat:nat")
		d := x.driver(t)
		caps, _ := d.Capabilities(ctx)
		if caps.Supports(router.CapPortForward) {
			t.Fatal("port forwarding must be refused without NAT")
		}
		if _, err := d.AddPortForward(ctx, router.PortForward{Protocol: "tcp", ExternalStart: 8080, InternalIP: "192.168.88.15"}); !errors.Is(err, router.ErrUnsupported) || len(x.writes) != 0 {
			t.Fatalf("want ErrUnsupported and no write, got %v", err)
		}
	})
}
