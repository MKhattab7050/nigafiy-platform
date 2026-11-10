// Package snmp reads what Port Detective needs from a managed switch or router, read-only:
// its interfaces, its forwarding table (which MAC address was learned on which port) and its LLDP
// neighbours. It only ever sends SNMP GET / GETNEXT / GETBULK; there is no SET anywhere.
package snmp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

const (
	oidSysDescr = ".1.3.6.1.2.1.1.1.0"
	oidSysName  = ".1.3.6.1.2.1.1.5.0"

	oidIfDescr       = ".1.3.6.1.2.1.2.2.1.2"
	oidIfSpeed       = ".1.3.6.1.2.1.2.2.1.5"
	oidIfAdminStatus = ".1.3.6.1.2.1.2.2.1.7"
	oidIfOperStatus  = ".1.3.6.1.2.1.2.2.1.8"
	oidIfInDiscards  = ".1.3.6.1.2.1.2.2.1.13"
	oidIfInErrors    = ".1.3.6.1.2.1.2.2.1.14"
	oidIfOutDiscards = ".1.3.6.1.2.1.2.2.1.19"
	oidIfOutErrors   = ".1.3.6.1.2.1.2.2.1.20"
	oidIfName        = ".1.3.6.1.2.1.31.1.1.1.1"
	oidIfHCInOctets  = ".1.3.6.1.2.1.31.1.1.1.6"
	oidIfHCOutOctets = ".1.3.6.1.2.1.31.1.1.1.10"
	oidIfHighSpeed   = ".1.3.6.1.2.1.31.1.1.1.15"
	oidIfAlias       = ".1.3.6.1.2.1.31.1.1.1.18"

	oidBasePortIfIndex = ".1.3.6.1.2.1.17.1.4.1.2"
	oidDot1dFdbPort    = ".1.3.6.1.2.1.17.4.3.1.2"
	oidDot1qFdbPort    = ".1.3.6.1.2.1.17.7.1.2.2.1.2"

	oidLldpLocPortID   = ".1.0.8802.1.1.2.1.3.7.1.3"
	oidLldpLocPortDesc = ".1.0.8802.1.1.2.1.3.7.1.4"
	oidLldpRemChassis  = ".1.0.8802.1.1.2.1.4.1.1.5"
	oidLldpRemPortID   = ".1.0.8802.1.1.2.1.4.1.1.7"
	oidLldpRemPortDesc = ".1.0.8802.1.1.2.1.4.1.1.8"
	oidLldpRemSysName  = ".1.0.8802.1.1.2.1.4.1.1.9"

	// Hard ceilings: a misbehaving agent cannot make the collector read without end.
	MaxPorts   = 1024
	MaxFDB     = 8192
	MaxLLDP    = 512
	maxWalkRow = 20000
)

// Target describes one device to read. Secrets live only in memory.
type Target struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Version   string `json:"version"` // "2c" or "3"
	Community string `json:"community,omitempty"`
	Username  string `json:"username,omitempty"`
	AuthProto string `json:"auth_protocol,omitempty"` // "sha" | "sha256" | "md5" | ""
	AuthPass  string `json:"auth_password,omitempty"`
	PrivProto string `json:"priv_protocol,omitempty"` // "aes" | "des" | ""
	PrivPass  string `json:"priv_password,omitempty"`
	// IntervalSeconds between polls; the agent applies its own floor.
	IntervalSeconds int `json:"interval_seconds"`
}

type Port struct {
	IfIndex     int    `json:"if_index"`
	Name        string `json:"name"`
	Descr       string `json:"descr,omitempty"`
	Alias       string `json:"alias,omitempty"`
	AdminUp     bool   `json:"admin_up"`
	OperUp      bool   `json:"oper_up"`
	SpeedMbps   int64  `json:"speed_mbps"`
	InErrors    uint64 `json:"in_errors"`
	OutErrors   uint64 `json:"out_errors"`
	InDiscards  uint64 `json:"in_discards"`
	OutDiscards uint64 `json:"out_discards"`
	InOctets    uint64 `json:"in_octets"`
	OutOctets   uint64 `json:"out_octets"`
}

type FDBEntry struct {
	MAC     string `json:"mac"`
	IfIndex int    `json:"if_index"`
	VLAN    int    `json:"vlan"`
}

type Neighbor struct {
	IfIndex   int    `json:"if_index"`
	SysName   string `json:"sys_name,omitempty"`
	PortID    string `json:"port_id,omitempty"`
	PortDescr string `json:"port_descr,omitempty"`
	ChassisID string `json:"chassis_id,omitempty"`
}

type Result struct {
	SysName  string     `json:"sys_name,omitempty"`
	SysDescr string     `json:"sys_descr,omitempty"`
	Ports    []Port     `json:"ports"`
	FDB      []FDBEntry `json:"fdb"`
	LLDP     []Neighbor `json:"lldp"`
	// Truncated lists what hit a ceiling, so the UI never presents a partial table as complete.
	Truncated []string `json:"truncated,omitempty"`
}

var errStop = errors.New("row limit reached")

func connect(ctx context.Context, t Target, timeout time.Duration) (*gosnmp.GoSNMP, error) {
	port := t.Port
	if port == 0 {
		port = 161
	}
	if net.ParseIP(t.Host) == nil {
		return nil, errors.New("target must be an IP address")
	}
	g := &gosnmp.GoSNMP{
		Target: t.Host, Port: uint16(port), Transport: "udp", Timeout: timeout, Retries: 1,
		MaxRepetitions: 25, MaxOids: gosnmp.MaxOids, Context: ctx,
	}
	switch t.Version {
	case "2c":
		if t.Community == "" {
			return nil, errors.New("community is missing")
		}
		g.Version, g.Community = gosnmp.Version2c, t.Community
	case "3":
		if t.Username == "" {
			return nil, errors.New("SNMPv3 user name is missing")
		}
		usm := &gosnmp.UsmSecurityParameters{UserName: t.Username}
		flags := gosnmp.NoAuthNoPriv
		switch strings.ToLower(t.AuthProto) {
		case "":
		case "md5":
			usm.AuthenticationProtocol = gosnmp.MD5
		case "sha":
			usm.AuthenticationProtocol = gosnmp.SHA
		case "sha256":
			usm.AuthenticationProtocol = gosnmp.SHA256
		default:
			return nil, errors.New("unsupported SNMPv3 authentication protocol")
		}
		if t.AuthProto != "" {
			usm.AuthenticationPassphrase, flags = t.AuthPass, gosnmp.AuthNoPriv
			switch strings.ToLower(t.PrivProto) {
			case "":
			case "aes":
				usm.PrivacyProtocol = gosnmp.AES
			case "des":
				usm.PrivacyProtocol = gosnmp.DES
			default:
				return nil, errors.New("unsupported SNMPv3 privacy protocol")
			}
			if t.PrivProto != "" {
				usm.PrivacyPassphrase, flags = t.PrivPass, gosnmp.AuthPriv
			}
		}
		g.Version, g.SecurityModel, g.MsgFlags, g.SecurityParameters = gosnmp.Version3, gosnmp.UserSecurityModel, flags, usm
	default:
		return nil, errors.New("unsupported SNMP version (use 2c or 3)")
	}
	if err := g.Connect(); err != nil {
		return nil, errors.New("cannot open a socket to the device")
	}
	return g, nil
}

// cleanErr turns library errors into messages that never contain the community or passwords.
func cleanErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return errors.New("stopped before the device finished answering")
	case strings.Contains(msg, "timeout"):
		return errors.New("no answer (wrong community / credentials, SNMP disabled, or the device does not allow this host)")
	case strings.Contains(msg, "authentication") || strings.Contains(msg, "decrypt") || strings.Contains(msg, "unknown user"):
		return errors.New("the device rejected the SNMPv3 credentials")
	}
	return errors.New("SNMP request failed")
}

func text(v any) string {
	switch x := v.(type) {
	case []byte:
		s := strings.TrimRight(string(x), "\x00")
		for _, r := range s {
			if r < 0x20 || r == 0x7f || r == 0xfffd {
				return hexBytes(x)
			}
		}
		return strings.TrimSpace(s)
	case string:
		return strings.TrimSpace(x)
	}
	return ""
}

func hexBytes(b []byte) string {
	parts := make([]string, len(b))
	for i, c := range b {
		parts[i] = fmt.Sprintf("%02x", c)
	}
	return strings.Join(parts, ":")
}

func num(v any) uint64 {
	n := gosnmp.ToBigInt(v)
	if n == nil || n.Sign() < 0 {
		return 0
	}
	return n.Uint64()
}

// suffix returns the numeric index after base, e.g. (".1.3.6.1.2.1.2.2.1.2", ".1.3.6.1.2.1.2.2.1.2.7") → [7].
func suffix(base, name string) []int {
	if !strings.HasPrefix(name, base+".") {
		return nil
	}
	parts := strings.Split(name[len(base)+1:], ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out[i] = n
	}
	return out
}

func macFrom(idx []int) string {
	if len(idx) != 6 {
		return ""
	}
	parts := make([]string, 6)
	for i, o := range idx {
		if o < 0 || o > 255 {
			return ""
		}
		parts[i] = fmt.Sprintf("%02x", o)
	}
	return strings.Join(parts, ":")
}

type walker struct {
	g *gosnmp.GoSNMP
}

// walk reads one column. A missing table (noSuchObject, empty walk) is not an error: many devices
// implement only part of these MIBs.
func (w walker) walk(base string, max int, fn func(idx []int, v any)) (truncated bool, err error) {
	rows := 0
	walkFn := func(p gosnmp.SnmpPDU) error {
		if p.Type == gosnmp.NoSuchObject || p.Type == gosnmp.NoSuchInstance || p.Type == gosnmp.EndOfMibView {
			return nil
		}
		idx := suffix(base, p.Name)
		if idx == nil {
			return nil
		}
		rows++
		if rows > max || rows > maxWalkRow {
			truncated = true
			return errStop
		}
		fn(idx, p.Value)
		return nil
	}
	err = w.g.BulkWalk(base, walkFn)
	if errors.Is(err, errStop) {
		return true, nil
	}
	return truncated, err
}

// Poll reads the device. A device that answers nothing at all returns an error; a device that
// answers but lacks a table simply yields that part empty.
func Poll(ctx context.Context, t Target, timeout time.Duration) (*Result, error) {
	g, err := connect(ctx, t, timeout)
	if err != nil {
		return nil, err
	}
	defer g.Conn.Close()

	res := &Result{Ports: []Port{}, FDB: []FDBEntry{}, LLDP: []Neighbor{}}
	sys, err := g.Get([]string{oidSysDescr, oidSysName})
	if err != nil {
		return nil, cleanErr(err)
	}
	for _, v := range sys.Variables {
		switch v.Name {
		case oidSysDescr:
			res.SysDescr = clip(text(v.Value), 300)
		case oidSysName:
			res.SysName = clip(text(v.Value), 120)
		}
	}

	w := walker{g}
	ports := map[int]*Port{}
	port := func(i int) *Port {
		p := ports[i]
		if p == nil {
			p = &Port{IfIndex: i}
			ports[i] = p
		}
		return p
	}
	type col struct {
		oid string
		set func(p *Port, v any)
	}
	first := true
	for _, c := range []col{
		{oidIfDescr, func(p *Port, v any) { p.Descr = clip(text(v), 120) }},
		{oidIfName, func(p *Port, v any) { p.Name = clip(text(v), 80) }},
		{oidIfAlias, func(p *Port, v any) { p.Alias = clip(text(v), 120) }},
		{oidIfAdminStatus, func(p *Port, v any) { p.AdminUp = num(v) == 1 }},
		{oidIfOperStatus, func(p *Port, v any) { p.OperUp = num(v) == 1 }},
		{oidIfSpeed, func(p *Port, v any) {
			if p.SpeedMbps == 0 {
				p.SpeedMbps = int64(num(v) / 1_000_000)
			}
		}},
		{oidIfHighSpeed, func(p *Port, v any) {
			if n := int64(num(v)); n > 0 {
				p.SpeedMbps = n
			}
		}},
		{oidIfInErrors, func(p *Port, v any) { p.InErrors = num(v) }},
		{oidIfOutErrors, func(p *Port, v any) { p.OutErrors = num(v) }},
		{oidIfInDiscards, func(p *Port, v any) { p.InDiscards = num(v) }},
		{oidIfOutDiscards, func(p *Port, v any) { p.OutDiscards = num(v) }},
		{oidIfHCInOctets, func(p *Port, v any) { p.InOctets = num(v) }},
		{oidIfHCOutOctets, func(p *Port, v any) { p.OutOctets = num(v) }},
	} {
		trunc, err := w.walk(c.oid, MaxPorts, func(idx []int, v any) {
			if len(idx) == 1 && (first || ports[idx[0]] != nil) {
				c.set(port(idx[0]), v)
			}
		})
		if err != nil {
			if first {
				return nil, cleanErr(err)
			}
			if ctx.Err() != nil {
				return nil, cleanErr(ctx.Err())
			}
			continue // optional column
		}
		if trunc && first {
			res.Truncated = append(res.Truncated, "ports")
		}
		first = false
	}
	for _, p := range ports {
		if p.Name == "" {
			p.Name = p.Descr
		}
		if p.Name == "" {
			p.Name = "if" + strconv.Itoa(p.IfIndex)
		}
		res.Ports = append(res.Ports, *p)
	}
	sort.Slice(res.Ports, func(i, j int) bool { return res.Ports[i].IfIndex < res.Ports[j].IfIndex })

	// Bridge port number → ifIndex. Without this table the bridge port is taken as the ifIndex.
	base := map[int]int{}
	_, _ = w.walk(oidBasePortIfIndex, MaxPorts, func(idx []int, v any) {
		if len(idx) == 1 {
			base[idx[0]] = int(num(v))
		}
	})
	toIf := func(bridgePort int) int {
		if i, ok := base[bridgePort]; ok {
			return i
		}
		return bridgePort
	}

	seen := map[string]bool{}
	add := func(mac string, bridgePort, vlan int) {
		if mac == "" || bridgePort <= 0 {
			return // port 0 = learned but not on a port (e.g. the switch's own address)
		}
		key := mac + "/" + strconv.Itoa(vlan)
		if seen[key] {
			return
		}
		seen[key] = true
		res.FDB = append(res.FDB, FDBEntry{MAC: mac, IfIndex: toIf(bridgePort), VLAN: vlan})
	}
	// VLAN-aware table first (it carries the VLAN); then the plain bridge table for MACs not seen.
	trunc, _ := w.walk(oidDot1qFdbPort, MaxFDB, func(idx []int, v any) {
		if len(idx) == 7 {
			add(macFrom(idx[1:]), int(num(v)), idx[0])
		}
	})
	qMACs := map[string]bool{}
	for _, e := range res.FDB {
		qMACs[e.MAC] = true
	}
	trunc2, _ := w.walk(oidDot1dFdbPort, MaxFDB, func(idx []int, v any) {
		if mac := macFrom(idx); mac != "" && !qMACs[mac] {
			add(mac, int(num(v)), 0)
		}
	})
	if trunc || trunc2 || len(res.FDB) > MaxFDB {
		res.Truncated = append(res.Truncated, "fdb")
		if len(res.FDB) > MaxFDB {
			res.FDB = res.FDB[:MaxFDB]
		}
	}
	sort.Slice(res.FDB, func(i, j int) bool {
		if res.FDB[i].IfIndex != res.FDB[j].IfIndex {
			return res.FDB[i].IfIndex < res.FDB[j].IfIndex
		}
		return res.FDB[i].MAC < res.FDB[j].MAC
	})

	// LLDP: neighbours are indexed by the local LLDP port number, which is matched to an interface
	// by its port id / description, falling back to the bridge-port table and then the number itself.
	locID, locDesc := map[int]string{}, map[int]string{}
	_, _ = w.walk(oidLldpLocPortID, MaxPorts, func(idx []int, v any) {
		if len(idx) == 1 {
			locID[idx[0]] = text(v)
		}
	})
	_, _ = w.walk(oidLldpLocPortDesc, MaxPorts, func(idx []int, v any) {
		if len(idx) == 1 {
			locDesc[idx[0]] = text(v)
		}
	})
	byName := map[string]int{}
	for _, p := range res.Ports {
		for _, n := range []string{p.Name, p.Descr} {
			if n != "" {
				byName[strings.ToLower(n)] = p.IfIndex
			}
		}
	}
	lldpIf := func(local int) int {
		for _, n := range []string{locID[local], locDesc[local]} {
			if i, ok := byName[strings.ToLower(n)]; ok && n != "" {
				return i
			}
		}
		if i, ok := base[local]; ok {
			return i
		}
		return local
	}
	nb := map[[2]int]*Neighbor{}
	get := func(idx []int) *Neighbor {
		if len(idx) != 3 {
			return nil
		}
		k := [2]int{idx[1], idx[2]}
		n := nb[k]
		if n == nil {
			if len(nb) >= MaxLLDP {
				return nil
			}
			n = &Neighbor{IfIndex: lldpIf(idx[1])}
			nb[k] = n
		}
		return n
	}
	for oid, set := range map[string]func(n *Neighbor, v any){
		oidLldpRemSysName:  func(n *Neighbor, v any) { n.SysName = clip(text(v), 120) },
		oidLldpRemPortID:   func(n *Neighbor, v any) { n.PortID = clip(text(v), 80) },
		oidLldpRemPortDesc: func(n *Neighbor, v any) { n.PortDescr = clip(text(v), 120) },
		oidLldpRemChassis:  func(n *Neighbor, v any) { n.ChassisID = clip(text(v), 80) },
	} {
		_, _ = w.walk(oid, MaxLLDP*4, func(idx []int, v any) {
			if n := get(idx); n != nil {
				set(n, v)
			}
		})
	}
	for _, n := range nb {
		res.LLDP = append(res.LLDP, *n)
	}
	sort.Slice(res.LLDP, func(i, j int) bool {
		if res.LLDP[i].IfIndex != res.LLDP[j].IfIndex {
			return res.LLDP[i].IfIndex < res.LLDP[j].IfIndex
		}
		return res.LLDP[i].SysName < res.LLDP[j].SysName
	})
	if ctx.Err() != nil {
		return nil, cleanErr(ctx.Err())
	}
	return res, nil
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
