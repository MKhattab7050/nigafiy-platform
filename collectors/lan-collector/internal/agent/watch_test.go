package agent

import (
	"context"
	"encoding/json"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lan-detective/lan-collector/internal/cloud"
	"github.com/lan-detective/lan-collector/internal/snmp"
	"github.com/lan-detective/lan-collector/internal/watch"
)

type watchFakes struct {
	mu    sync.Mutex
	http  []watch.HTTPSpec
	tls   []watch.TLSSpec
	snmp  []snmp.Target
	guard []watch.Guard
}

func (f *watchFakes) deps() Deps {
	return Deps{
		WatchHTTP: func(_ context.Context, spec watch.HTTPSpec, g watch.Guard) watch.Result {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.http, f.guard = append(f.http, spec), append(f.guard, g)
			v := 200.0
			return watch.Result{OK: true, Value: &v, Resolved: "192.168.1.20", Details: map[string]any{"status_code": 200}}
		},
		WatchTLS: func(_ context.Context, spec watch.TLSSpec, g watch.Guard) watch.Result {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.tls, f.guard = append(f.tls, spec), append(f.guard, g)
			v := 12.5
			return watch.Result{OK: true, Value: &v}
		},
		SNMPGet: func(_ context.Context, t snmp.Target, oids []string, _ time.Duration) ([]snmp.Value, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.snmp = append(f.snmp, t)
			n := 42.0
			return []snmp.Value{{OID: oids[0], Type: "Gauge32", Raw: "42", Number: &n}}, nil
		},
	}
}

func (a *Agent) queuedItems(t *testing.T) []map[string]any {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]map[string]any, 0, len(a.queue))
	for _, raw := range a.queue {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	a.queue = nil
	return out
}

func TestWatchChecksDispatchWithGuardAndCredentials(t *testing.T) {
	f := &watchFakes{}
	a := smartAgent(t, f.deps())
	snmpRaw, _ := json.Marshal(map[string]any{"targets": []map[string]any{
		{"id": "sw-in", "host": "192.168.1.2", "port": 161, "version": "2c", "community": "c1", "interval_seconds": 300},
		{"id": "sw-out", "host": "10.9.9.9", "port": 161, "version": "2c", "community": "c2", "interval_seconds": 300},
	}})
	rc := &cloud.RemoteConfig{SNMP: snmpRaw}
	rc.Discovery.Scopes = []cloud.Scope{{ID: smartScopeID, CIDR: "192.168.1.0/24"}}
	a.mu.Lock()
	a.remote = rc
	a.mu.Unlock()
	port := 8443
	tlsPort := 443
	now := time.Now().UTC()

	a.runCheck(context.Background(), cloud.Check{ID: "c-http", Kind: "https", Target: "nas.lan", Port: &port,
		Config: json.RawMessage(`{"path":"/health","method":"GET","allow_public":true,"tls_verify":false}`)})
	a.runCheck(context.Background(), cloud.Check{ID: "c-tls", Kind: "tls_expiry", Target: "192.168.1.20", Port: &tlsPort, Config: json.RawMessage(`{"sni":"nas.lan"}`)})
	a.runCheck(context.Background(), cloud.Check{ID: "c-snmp", Kind: "snmp_oid", Target: "192.168.1.2", SNMPTargetID: "sw-in", Config: json.RawMessage(`{"oid":".1.3.6.1.2.1.25.3.3.1.2.1"}`)})
	a.runCheck(context.Background(), cloud.Check{ID: "c-snmp-out", Kind: "snmp_oid", Target: "10.9.9.9", SNMPTargetID: "sw-out", Config: json.RawMessage(`{"oid":".1.3.6.1.2.1.1.3.0"}`)})
	a.runCheck(context.Background(), cloud.Check{ID: "c-snmp-missing", Kind: "snmp_oid", Target: "192.168.1.3", SNMPTargetID: "gone", Config: json.RawMessage(`{"oid":".1.3.6.1.2.1.1.3.0"}`)})

	if len(f.http) != 1 || f.http[0].Scheme != "https" || f.http[0].Port != 8443 || f.http[0].Config.Path != "/health" || f.http[0].Config.TLSVerify == nil || *f.http[0].Config.TLSVerify {
		t.Fatalf("http spec: %+v", f.http)
	}
	if !f.guard[0].AllowPublic || len(f.guard[0].Scopes) != 1 || f.guard[0].Scopes[0] != netip.MustParsePrefix("192.168.1.0/24") {
		t.Fatalf("guard carries the authorized scopes and the opt-in: %+v", f.guard[0])
	}
	if len(f.tls) != 1 || f.tls[0].Config.SNI != "nas.lan" || f.guard[1].AllowPublic {
		t.Fatalf("tls spec: %+v %+v", f.tls, f.guard[1])
	}
	if len(f.snmp) != 1 || f.snmp[0].ID != "sw-in" || f.snmp[0].Community != "c1" {
		t.Fatalf("only the in-scope device is read, with its delivered credentials: %+v", f.snmp)
	}

	items := map[string]map[string]any{}
	for _, it := range a.queuedItems(t) {
		items[it["check_id"].(string)] = it
	}
	if it := items["c-http"]; it["ok"] != true || it["value"] != 200.0 || it["resolved_target"] != "192.168.1.20" || it["details"].(map[string]any)["status_code"] != 200.0 {
		t.Errorf("http item: %+v", it)
	}
	if it := items["c-tls"]; it["value"] != 12.5 {
		t.Errorf("tls item: %+v", it)
	}
	if it := items["c-snmp"]; it["ok"] != true || it["value"] != 42.0 || it["details"].(map[string]any)["raw_value"] != "42" {
		t.Errorf("snmp item: %+v", it)
	}
	if it := items["c-snmp-out"]; it["ok"] != false || !strings.HasPrefix(it["error"].(string), "refused:") {
		t.Errorf("out-of-scope device: %+v", it)
	}
	if it := items["c-snmp-missing"]; it["ok"] != false || !strings.Contains(it["error"].(string), "credentials have not been received") {
		t.Errorf("missing credentials: %+v", it)
	}
	for id, it := range items {
		ts, err := time.Parse(time.RFC3339Nano, it["ts"].(string))
		if err != nil || ts.Before(now.Add(-time.Minute)) {
			t.Errorf("%s: timestamp %v", id, it["ts"])
		}
	}
}
