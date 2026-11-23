package watch

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/nigafiy/sensor/internal/snmp"
)

// SNMPConfig is an snmp_oid check's settings as delivered by the cloud. The thresholds are applied by
// the cloud; the collector reads the value and applies the multiplier / ratio.
type SNMPConfig struct {
	OID      string   `json:"oid"`
	RatioOID string   `json:"ratio_oid"`
	Scale    *float64 `json:"scale"`
}

// SNMPGetter reads OIDs from one device (snmp.GetValues).
type SNMPGetter func(ctx context.Context, t snmp.Target, oids []string, timeout time.Duration) ([]snmp.Value, error)

// SNMPOID reads one OID (and, for a ratio, its divisor) and computes the check value:
// raw × scale, or 100 × raw / ratio × scale for a percentage (scale defaults to 1).
func SNMPOID(ctx context.Context, t snmp.Target, cfg SNMPConfig, get SNMPGetter, timeout time.Duration) Result {
	if get == nil {
		return Result{Error: "SNMP reads are not available on this collector"}
	}
	if cfg.OID == "" {
		return Result{Error: "the check has no OID"}
	}
	oids := []string{cfg.OID}
	if cfg.RatioOID != "" {
		oids = append(oids, cfg.RatioOID)
	}
	start := time.Now()
	values, err := get(ctx, t, oids, timeout)
	latency := time.Since(start)
	if err != nil {
		return Result{Error: err.Error(), Resolved: t.Host}
	}
	if len(values) != len(oids) {
		return Result{Error: "the device answered an incomplete request", Resolved: t.Host}
	}
	main := values[0]
	details := map[string]any{"oid": clip(main.OID, 128), "raw_value": clip(main.Raw, 120), "value_type": clip(main.Type, 32)}
	res := Result{LatencyMs: ms(latency), Resolved: t.Host, Details: details}
	if main.Number == nil {
		res.Error = "the OID's value is not a number (" + clip(main.Type, 32) + ")"
		return res
	}
	value := *main.Number
	if cfg.RatioOID != "" {
		ratio := values[1]
		details["ratio_raw"] = clip(ratio.Raw, 120)
		if ratio.Number == nil || *ratio.Number == 0 {
			res.Error = "the divisor OID is zero or not a number"
			return res
		}
		value = 100 * value / *ratio.Number
	}
	if cfg.Scale != nil {
		if *cfg.Scale <= 0 {
			res.Error = "the multiplier must be positive"
			return res
		}
		value *= *cfg.Scale
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		res.Error = "the computed value is not a finite number"
		return res
	}
	value, _ = strconv.ParseFloat(strconv.FormatFloat(value, 'f', 4, 64), 64)
	res.Value = num(value)
	res.OK = true
	return res
}
