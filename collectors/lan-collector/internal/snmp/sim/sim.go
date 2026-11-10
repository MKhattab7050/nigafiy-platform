// Package sim is a tiny read-only SNMP v2c agent that plays a managed switch. It exists for tests
// and for looking at Port Detective without hardware (cmd/snmp-sim). It is never started by the
// collector itself.
package sim

import (
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/gosnmp/gosnmp"
)

type entry struct {
	oid   []int
	name  string
	typ   gosnmp.Asn1BER
	value any
}

// Agent serves a fixed OID tree.
type Agent struct {
	Community string
	entries   []entry
	conn      net.PacketConn
}

func parse(oid string) []int {
	parts := strings.Split(strings.TrimPrefix(oid, "."), ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}

func less(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func (a *Agent) Set(oid string, typ gosnmp.Asn1BER, value any) {
	a.entries = append(a.entries, entry{oid: parse(oid), name: "." + strings.TrimPrefix(oid, "."), typ: typ, value: value})
}

func (a *Agent) Str(oid, v string)        { a.Set(oid, gosnmp.OctetString, []byte(v)) }
func (a *Agent) Int(oid string, v int)    { a.Set(oid, gosnmp.Integer, v) }
func (a *Agent) Gauge(oid string, v uint) { a.Set(oid, gosnmp.Gauge32, v) }
func (a *Agent) Counter(oid string, v uint) {
	a.Set(oid, gosnmp.Counter32, v)
}
func (a *Agent) Counter64(oid string, v uint64) { a.Set(oid, gosnmp.Counter64, v) }

func (a *Agent) next(oid string) (entry, bool) {
	want := parse(oid)
	i := sort.Search(len(a.entries), func(i int) bool { return less(want, a.entries[i].oid) })
	if i >= len(a.entries) {
		return entry{}, false
	}
	return a.entries[i], true
}

func (a *Agent) exact(oid string) (entry, bool) {
	for _, e := range a.entries {
		if e.name == oid {
			return e, true
		}
	}
	return entry{}, false
}

// Start listens on addr ("127.0.0.1:0") and returns the bound address.
func (a *Agent) Start(addr string) (string, error) {
	sort.Slice(a.entries, func(i, j int) bool { return less(a.entries[i].oid, a.entries[j].oid) })
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return "", err
	}
	a.conn = pc
	go a.serve()
	return pc.LocalAddr().String(), nil
}

func (a *Agent) Stop() {
	if a.conn != nil {
		a.conn.Close()
	}
}

func (a *Agent) serve() {
	dec := &gosnmp.GoSNMP{Version: gosnmp.Version2c, Logger: gosnmp.NewLogger(nil)}
	buf := make([]byte, 65535)
	for {
		n, from, err := a.conn.ReadFrom(buf)
		if err != nil {
			return
		}
		req, err := dec.SnmpDecodePacket(buf[:n])
		if err != nil || req.Community != a.Community {
			continue // like a real agent: wrong community gets silence
		}
		resp := &gosnmp.SnmpPacket{Version: gosnmp.Version2c, Community: req.Community, PDUType: gosnmp.GetResponse, RequestID: req.RequestID}
		end := func(name string) gosnmp.SnmpPDU {
			return gosnmp.SnmpPDU{Name: name, Type: gosnmp.EndOfMibView, Value: nil}
		}
		switch req.PDUType {
		case gosnmp.GetRequest:
			for _, v := range req.Variables {
				if e, ok := a.exact(v.Name); ok {
					resp.Variables = append(resp.Variables, gosnmp.SnmpPDU{Name: e.name, Type: e.typ, Value: e.value})
				} else {
					resp.Variables = append(resp.Variables, gosnmp.SnmpPDU{Name: v.Name, Type: gosnmp.NoSuchObject, Value: nil})
				}
			}
		case gosnmp.GetNextRequest, gosnmp.GetBulkRequest:
			reps := 1
			if req.PDUType == gosnmp.GetBulkRequest {
				reps = int(req.MaxRepetitions)
				if reps < 1 {
					reps = 1
				}
				if reps > 40 {
					reps = 40
				}
			}
			for _, v := range req.Variables {
				cur := v.Name
				for i := 0; i < reps; i++ {
					e, ok := a.next(cur)
					if !ok {
						resp.Variables = append(resp.Variables, end(cur))
						break
					}
					resp.Variables = append(resp.Variables, gosnmp.SnmpPDU{Name: e.name, Type: e.typ, Value: e.value})
					cur = e.name
				}
			}
		default:
			continue // read-only: SET and everything else is ignored
		}
		out, err := resp.MarshalMsg()
		if err != nil {
			continue
		}
		_, _ = a.conn.WriteTo(out, from)
	}
}

// Device on a switch port, used to build a demo switch.
type Device struct {
	MAC  string
	Port int
	VLAN int
}

func macIndex(mac string) string {
	hw, _ := net.ParseMAC(mac)
	parts := make([]string, len(hw))
	for i, b := range hw {
		parts[i] = strconv.Itoa(int(b))
	}
	return strings.Join(parts, ".")
}

// Switch builds an agent that looks like a small managed switch with `ports` copper ports. Bridge
// port n maps to ifIndex 100+n so the mapping table is exercised. The last port carries an LLDP
// neighbour when uplinkName is set.
func Switch(community, name string, ports int, devices []Device, uplinkName string) *Agent {
	a := &Agent{Community: community}
	a.Str("1.3.6.1.2.1.1.1.0", "Simulated 8-port managed switch (LAN Detective test agent)")
	a.Str("1.3.6.1.2.1.1.5.0", name)
	used := map[int]bool{}
	for _, d := range devices {
		used[d.Port] = true
	}
	for p := 1; p <= ports; p++ {
		i := 100 + p
		up := 2
		if used[p] || (p == ports && uplinkName != "") {
			up = 1
		}
		a.Str(fmt.Sprintf("1.3.6.1.2.1.2.2.1.2.%d", i), fmt.Sprintf("GigabitEthernet0/%d", p))
		a.Gauge(fmt.Sprintf("1.3.6.1.2.1.2.2.1.5.%d", i), 1_000_000_000)
		a.Int(fmt.Sprintf("1.3.6.1.2.1.2.2.1.7.%d", i), 1)
		a.Int(fmt.Sprintf("1.3.6.1.2.1.2.2.1.8.%d", i), up)
		a.Counter(fmt.Sprintf("1.3.6.1.2.1.2.2.1.13.%d", i), 0)
		a.Counter(fmt.Sprintf("1.3.6.1.2.1.2.2.1.14.%d", i), uint(p*3))
		a.Counter(fmt.Sprintf("1.3.6.1.2.1.2.2.1.19.%d", i), 0)
		a.Counter(fmt.Sprintf("1.3.6.1.2.1.2.2.1.20.%d", i), 0)
		a.Str(fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.1.%d", i), fmt.Sprintf("Gi0/%d", p))
		a.Counter64(fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.6.%d", i), uint64(p)*1_000_000)
		a.Counter64(fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.10.%d", i), uint64(p)*2_000_000)
		a.Gauge(fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.15.%d", i), 1000)
		alias := ""
		if p == ports && uplinkName != "" {
			alias = "Uplink"
		}
		a.Str(fmt.Sprintf("1.3.6.1.2.1.31.1.1.1.18.%d", i), alias)
		a.Int(fmt.Sprintf("1.3.6.1.2.1.17.1.4.1.2.%d", p), i)
		a.Str(fmt.Sprintf("1.0.8802.1.1.2.1.3.7.1.3.%d", p), fmt.Sprintf("Gi0/%d", p))
	}
	for _, d := range devices {
		if d.VLAN > 0 {
			a.Int(fmt.Sprintf("1.3.6.1.2.1.17.7.1.2.2.1.2.%d.%s", d.VLAN, macIndex(d.MAC)), d.Port)
		} else {
			a.Int(fmt.Sprintf("1.3.6.1.2.1.17.4.3.1.2.%s", macIndex(d.MAC)), d.Port)
		}
	}
	if uplinkName != "" {
		idx := fmt.Sprintf("0.%d.1", ports)
		a.Set("1.0.8802.1.1.2.1.4.1.1.5."+idx, gosnmp.OctetString, []byte{0x00, 0x11, 0x22, 0xaa, 0xbb, 0xcc})
		a.Str("1.0.8802.1.1.2.1.4.1.1.7."+idx, "Gi1/0/24")
		a.Str("1.0.8802.1.1.2.1.4.1.1.8."+idx, "to access switch")
		a.Str("1.0.8802.1.1.2.1.4.1.1.9."+idx, uplinkName)
	}
	return a
}
