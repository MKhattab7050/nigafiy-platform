package watch

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/snmp"
	"github.com/nigafiy/sensor/internal/snmp/sim"
)

func simTarget(t *testing.T, a *sim.Agent) snmp.Target {
	t.Helper()
	addr, err := a.Start("127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind loopback UDP:", err)
	}
	t.Cleanup(a.Stop)
	host, port, _ := net.SplitHostPort(addr)
	p, _ := strconv.Atoi(port)
	return snmp.Target{ID: "t1", Host: host, Port: p, Version: "2c", Community: a.Community}
}

func f64(v float64) *float64 { return &v }

func TestSNMPOIDAgainstSimulatedDevice(t *testing.T) {
	a := sim.Switch("ro-community", "sw-core", 4, nil, "")
	a.Gauge("1.3.6.1.2.1.25.3.3.1.2.196608", 37)   // hrProcessorLoad
	a.Int("1.3.6.1.2.1.25.2.3.1.6.65536", 192_000) // hrStorageUsed
	a.Int("1.3.6.1.2.1.25.2.3.1.5.65536", 256_000) // hrStorageSize
	a.Int("1.3.6.1.4.1.14988.1.1.3.10.0", 415)     // mtxrHlTemperature, tenths of a degree
	a.Str("1.3.6.1.4.1.99999.1.0", "not a number") // a text value
	a.Int("1.3.6.1.4.1.99999.2.0", 0)              // a zero divisor
	target := simTarget(t, a)
	run := func(cfg SNMPConfig) Result {
		return SNMPOID(context.Background(), target, cfg, snmp.GetValues, 2*time.Second)
	}

	res := run(SNMPConfig{OID: ".1.3.6.1.2.1.25.3.3.1.2.196608"})
	if !res.OK || *res.Value != 37 || res.Details["raw_value"] != "37" || res.Details["value_type"] != "Gauge32" || res.Resolved != "127.0.0.1" {
		t.Fatalf("cpu: %+v", res)
	}
	res = run(SNMPConfig{OID: "1.3.6.1.2.1.25.2.3.1.6.65536", RatioOID: "1.3.6.1.2.1.25.2.3.1.5.65536"})
	if !res.OK || *res.Value != 75 || res.Details["ratio_raw"] != "256000" {
		t.Fatalf("memory ratio: %+v", res)
	}
	res = run(SNMPConfig{OID: "1.3.6.1.4.1.14988.1.1.3.10.0", Scale: f64(0.1)})
	if !res.OK || *res.Value != 41.5 {
		t.Fatalf("scaled temperature: %+v", res)
	}
	// ifOperStatus of port 2 (down in the simulated switch: nothing connected).
	res = run(SNMPConfig{OID: "1.3.6.1.2.1.2.2.1.8.102"})
	if !res.OK || *res.Value != 2 {
		t.Fatalf("link status: %+v", res)
	}
	res = run(SNMPConfig{OID: "1.3.6.1.4.1.99999.1.0"})
	if res.OK || !strings.Contains(res.Error, "not a number") {
		t.Fatalf("text value: %+v", res)
	}
	res = run(SNMPConfig{OID: "1.3.6.1.2.1.25.2.3.1.6.65536", RatioOID: "1.3.6.1.4.1.99999.2.0"})
	if res.OK || !strings.Contains(res.Error, "divisor") {
		t.Fatalf("zero divisor: %+v", res)
	}
	res = run(SNMPConfig{OID: "1.3.6.1.2.1.25.3.3.1.2.1"})
	if res.OK || !strings.Contains(res.Error, "does not implement OID .1.3.6.1.2.1.25.3.3.1.2.1") {
		t.Fatalf("missing OID: %+v", res)
	}
	// A wrong community gets silence, reported without the community.
	bad := target
	bad.Community = "wrong-secret"
	res = SNMPOID(context.Background(), bad, SNMPConfig{OID: "1.3.6.1.2.1.25.3.3.1.2.196608"}, snmp.GetValues, 300*time.Millisecond)
	if res.OK || strings.Contains(res.Error, "wrong-secret") || !strings.Contains(res.Error, "no answer") {
		t.Fatalf("wrong community: %+v", res)
	}
}
