package snmp

import (
	"context"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Value is one OID read with GetValues.
type Value struct {
	OID string
	// Type is the SNMP type name ("Integer", "Gauge32", "Counter64", "OctetString", ...).
	Type string
	// Raw is the value as text (numbers in decimal, strings as received, binary as hex).
	Raw string
	// Number is set when the value is numeric (or a string that is a plain decimal number).
	Number *float64
}

// MaxGetOIDs bounds one GetValues call (a watch check reads one OID, or two for a ratio).
const MaxGetOIDs = 4

// GetValues reads the given OIDs with a single SNMP GET. Read-only: it never sends SET. An OID the
// device does not implement is an error that says so; a device that does not answer is the same
// cleaned error as a Port Detective read (no credentials in messages).
func GetValues(ctx context.Context, t Target, oids []string, timeout time.Duration) ([]Value, error) {
	if len(oids) == 0 || len(oids) > MaxGetOIDs {
		return nil, errors.New("between 1 and 4 OIDs can be read at once")
	}
	norm := make([]string, len(oids))
	for i, o := range oids {
		if !validOID(o) {
			return nil, errors.New("not a numeric OID")
		}
		norm[i] = "." + strings.TrimPrefix(o, ".")
	}
	g, err := connect(ctx, t, timeout)
	if err != nil {
		return nil, err
	}
	defer g.Conn.Close()
	pkt, err := g.Get(norm)
	if err != nil {
		return nil, cleanErr(err)
	}
	if pkt.Error != gosnmp.NoError {
		return nil, errors.New("the device refused the request (" + pkt.Error.String() + ")")
	}
	out := make([]Value, 0, len(norm))
	for _, want := range norm {
		var pdu *gosnmp.SnmpPDU
		for i := range pkt.Variables {
			if pkt.Variables[i].Name == want {
				pdu = &pkt.Variables[i]
				break
			}
		}
		if pdu == nil || pdu.Type == gosnmp.NoSuchObject || pdu.Type == gosnmp.NoSuchInstance || pdu.Type == gosnmp.EndOfMibView || pdu.Type == gosnmp.Null {
			return nil, errors.New("the device does not implement OID " + want + " (check the OID and its index)")
		}
		out = append(out, decode(want, *pdu))
	}
	return out, nil
}

func validOID(o string) bool {
	o = strings.TrimPrefix(o, ".")
	if o == "" || len(o) > 128 {
		return false
	}
	for _, part := range strings.Split(o, ".") {
		if part == "" {
			return false
		}
		if _, err := strconv.ParseUint(part, 10, 32); err != nil {
			return false
		}
	}
	return true
}

func decode(oid string, p gosnmp.SnmpPDU) Value {
	v := Value{OID: oid, Type: p.Type.String()}
	switch p.Type {
	case gosnmp.Integer, gosnmp.Counter32, gosnmp.Gauge32, gosnmp.TimeTicks, gosnmp.Counter64, gosnmp.Uinteger32:
		n := gosnmp.ToBigInt(p.Value)
		if n == nil {
			n = big.NewInt(0)
		}
		v.Raw = n.String()
		f, _ := new(big.Float).SetInt(n).Float64()
		v.Number = &f
	case gosnmp.OpaqueFloat:
		if f, ok := p.Value.(float32); ok {
			x := float64(f)
			v.Number, v.Raw = &x, strconv.FormatFloat(x, 'f', -1, 32)
		}
	case gosnmp.OpaqueDouble:
		if f, ok := p.Value.(float64); ok {
			v.Number, v.Raw = &f, strconv.FormatFloat(f, 'f', -1, 64)
		}
	default:
		v.Raw = clip(text(p.Value), 120)
		// Some agents report numbers as strings ("42", "41.5 C" is not accepted: only a plain number).
		if f, err := strconv.ParseFloat(strings.TrimSpace(v.Raw), 64); err == nil {
			v.Number = &f
		}
	}
	return v
}
