package openwrt

// Rate limits on OpenWrt (Built: R2, docs/features/router-controls.md), only where the nft-qos
// package (and usually luci-app-nft-qos) is installed: OpenWrt itself has no per-device limiter.
//
// nft-qos (openwrt/packages net/nft-qos, OpenWrt 19.07–23.05; files/nft-qos.config and
// files/lib/mac.sh): section `config default 'default'` with `option limit_mac_enable '1'` turns
// on MAC-based limits; each `config client` section has `macaddr`, `drate`/`drunit` (download) and
// `urate`/`urunit` (upload), rates in the nft units bytes/kbytes/mbytes per second. A direction
// without a rate is not limited. Detected with `uci get nft-qos` (ubus NOT_FOUND when the package
// is absent); applied with uci commit and an `nft-qos` init restart (luci.setInitAction, else
// rc.init — the same two ways the firewall reload uses).
//
// Nigafiy's client sections carry `option hostname 'LAN Detective: <mac>'` and are the only ones it
// changes or deletes. A MAC the administrator already limits in nft-qos is refused. When
// limit_mac_enable was off, Nigafiy turns it on, records that with `option nigafiy_enabled_mac '1'`
// and turns it off again when its last client section is removed; this is said in the change.
// kbit/s are converted to whole kbytes/s (rounded up, at least 1), so the limit is at most 7 kbit/s
// looser than asked.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

const (
	mechLimit      = "nft-qos MAC-based limits (UCI nft-qos client sections)"
	ubusNotFound   = 4
	limitHostLabel = router.ProductRulePrefix
)

var _ router.RateLimiter = (*Driver)(nil)

type qosConfig struct {
	defaultID string
	defaults  map[string]any
	clients   map[string]map[string]any // section id → values
}

// nftQoS reads the nft-qos configuration; ok is false when the package is not installed.
func (d *Driver) nftQoS(ctx context.Context, op string) (qosConfig, bool, error) {
	code, data, err := d.call(ctx, op, "uci", "get", map[string]string{"config": "nft-qos"})
	if err != nil {
		return qosConfig{}, false, err
	}
	if code == ubusNotFound {
		return qosConfig{}, false, nil
	}
	if code != ubusStatusOK {
		return qosConfig{}, false, router.Errorf(router.ErrProtocol, op, "uci.get nft-qos returned code %d", code)
	}
	var rep struct {
		Values map[string]map[string]any `json:"values"`
	}
	if err := json.Unmarshal(data, &rep); err != nil {
		return qosConfig{}, false, router.Errorf(router.ErrProtocol, op, "unreadable uci nft-qos config")
	}
	cfg := qosConfig{clients: map[string]map[string]any{}}
	for id, v := range rep.Values {
		switch strVal(v[".type"]) {
		case "default":
			cfg.defaultID, cfg.defaults = id, v
		case "client":
			cfg.clients[id] = v
		}
	}
	if cfg.defaultID == "" {
		return qosConfig{}, false, router.Errorf(router.ErrProtocol, op, "nft-qos has no default section")
	}
	return cfg, true, nil
}

func (cfg qosConfig) forMAC(mac string) (own, admin string) {
	for id, v := range cfg.clients {
		m, err := router.NormalizeMAC(strVal(v["macaddr"]))
		if err != nil || m != mac {
			continue
		}
		if strVal(v["hostname"]) == limitHostLabel+mac {
			own = id
		} else {
			admin = id
		}
	}
	return
}

func (cfg qosConfig) ownCount() int {
	n := 0
	for _, v := range cfg.clients {
		if strings.HasPrefix(strVal(v["hostname"]), limitHostLabel) {
			n++
		}
	}
	return n
}

func kbytes(kbps int) int { return (kbps + 7) / 8 }

func (d *Driver) uci(ctx context.Context, op, method string, args map[string]any) (json.RawMessage, error) {
	code, data, err := d.call(ctx, op, "uci", method, args)
	if err != nil {
		return nil, err
	}
	if code != ubusStatusOK {
		return nil, router.Errorf(router.ErrRejected, op, "uci.%s nft-qos failed (code %d)", method, code)
	}
	return data, nil
}

func (d *Driver) commitQoS(ctx context.Context, op string) error {
	if _, err := d.uci(ctx, op, "commit", map[string]any{"config": "nft-qos"}); err != nil {
		return err
	}
	if c, _, err := d.call(ctx, op, "luci", "setInitAction", map[string]string{"name": "nft-qos", "action": "restart"}); err != nil || c != ubusStatusOK {
		if c2, _, err2 := d.call(ctx, op, "rc", "init", map[string]string{"name": "nft-qos", "action": "restart"}); err2 != nil || c2 != ubusStatusOK {
			return router.Errorf(router.ErrRejected, op, "the nft-qos configuration was saved but the service could not be restarted (luci.setInitAction and rc.init both refused); restart nft-qos in LuCI → System → Startup")
		}
	}
	return nil
}

func limitCapability(installed bool, err error) router.CapabilityStatus {
	switch {
	case err != nil:
		return router.CapabilityStatus{Capability: router.CapRateLimit, Supported: false, Note: "Not offered: the nft-qos configuration could not be read (" + err.Error() + ")"}
	case !installed:
		return router.CapabilityStatus{Capability: router.CapRateLimit, Supported: false, Note: "Not offered: OpenWrt has no per-device speed limit of its own; install the nft-qos package (luci-app-nft-qos) and Nigafiy limits devices through its MAC-based limits"}
	}
	return router.CapabilityStatus{Capability: router.CapRateLimit, Supported: true, Mechanism: mechLimit,
		Note: "Adds an nft-qos MAC-based limit for the device (rates in whole kbytes/s, so up to 7 kbit/s looser than asked); turns on nft-qos MAC limits if they were off and says so"}
}

// SetRateLimit adds or updates the device's nft-qos client section.
func (d *Driver) SetRateLimit(ctx context.Context, rawMAC string, limit router.RateLimit) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	if err := router.ValidateRateLimit(limit); err != nil {
		return router.Change{}, err
	}
	cfg, ok, err := d.nftQoS(ctx, "rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	if !ok {
		return router.Change{}, router.Errorf(router.ErrUnsupported, "rate_limit", "the nft-qos package is not installed on this OpenWrt router")
	}
	own, admin := cfg.forMAC(mac)
	if admin != "" {
		return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "the administrator already limits %s in nft-qos (section %s); Nigafiy does not change it", mac, admin)
	}
	vals := map[string]any{"macaddr": mac, "hostname": limitHostLabel + mac}
	var clear []string
	if limit.DownKbps > 0 {
		vals["drate"], vals["drunit"] = strconv.Itoa(kbytes(limit.DownKbps)), "kbytes"
	} else {
		clear = append(clear, "drate", "drunit")
	}
	if limit.UpKbps > 0 {
		vals["urate"], vals["urunit"] = strconv.Itoa(kbytes(limit.UpKbps)), "kbytes"
	} else {
		clear = append(clear, "urate", "urunit")
	}
	if own == "" {
		data, err := d.uci(ctx, "rate_limit", "add", map[string]any{"config": "nft-qos", "type": "client", "values": vals})
		if err != nil {
			return router.Change{}, err
		}
		var added struct {
			Section string `json:"section"`
		}
		_ = json.Unmarshal(data, &added)
		own = added.Section
	} else {
		if _, err := d.uci(ctx, "rate_limit", "set", map[string]any{"config": "nft-qos", "section": own, "values": vals}); err != nil {
			return router.Change{}, err
		}
		if len(clear) > 0 {
			if _, err := d.uci(ctx, "rate_limit", "delete", map[string]any{"config": "nft-qos", "section": own, "options": clear}); err != nil {
				return router.Change{}, err
			}
		}
	}
	enabled := ""
	if strVal(cfg.defaults["limit_mac_enable"]) != "1" {
		if _, err := d.uci(ctx, "rate_limit", "set", map[string]any{"config": "nft-qos", "section": cfg.defaultID, "values": map[string]any{"limit_mac_enable": "1", "nigafiy_enabled_mac": "1"}}); err != nil {
			return router.Change{}, err
		}
		enabled = "; nft-qos MAC-based limits were off and are now on (turned off again when the last Nigafiy limit is removed)"
	}
	if err := d.commitQoS(ctx, "rate_limit"); err != nil {
		return router.Change{}, err
	}
	// Re-read.
	cfg, _, err = d.nftQoS(ctx, "rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	o, _ := cfg.forMAC(mac)
	v := cfg.clients[o]
	if o == "" || strVal(cfg.defaults["limit_mac_enable"]) != "1" || strVal(v["drate"]) != strVal(vals["drate"]) || strVal(v["urate"]) != strVal(vals["urate"]) {
		return router.Change{}, router.Errorf(router.ErrRejected, "rate_limit", "OpenWrt accepted the change but nft-qos does not show the new limit for %s", mac)
	}
	return router.Change{
		Action:    "rate_limit",
		MAC:       mac,
		Mechanism: mechLimit,
		Applied:   true,
		Detail:    fmt.Sprintf("nft-qos limits %s: %s (download %s, upload %s kbytes/s)%s", mac, router.DescribeLimit(limit), orNone(v["drate"]), orNone(v["urate"]), enabled),
		Undo:      fmt.Sprintf("Remove the limit in Nigafiy, or delete the client %q in LuCI → Services → QoS over Nftables", limitHostLabel+mac),
	}, nil
}

func orNone(v any) string {
	if s := strVal(v); s != "" {
		return s
	}
	return "no limit"
}

// ClearRateLimit deletes the device's nft-qos client section.
func (d *Driver) ClearRateLimit(ctx context.Context, rawMAC string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	cfg, ok, err := d.nftQoS(ctx, "clear_rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	own := ""
	if ok {
		own, _ = cfg.forMAC(mac)
	}
	if own == "" {
		return router.Change{Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: false, AlreadyInEffect: true, Detail: "no Nigafiy nft-qos limit for this device (the administrator's limits are left as they are)"}, nil
	}
	if _, err := d.uci(ctx, "clear_rate_limit", "delete", map[string]any{"config": "nft-qos", "section": own}); err != nil {
		return router.Change{}, err
	}
	disabled := ""
	if cfg.ownCount() == 1 && strVal(cfg.defaults["nigafiy_enabled_mac"]) == "1" {
		if _, err := d.uci(ctx, "clear_rate_limit", "set", map[string]any{"config": "nft-qos", "section": cfg.defaultID, "values": map[string]any{"limit_mac_enable": "0"}}); err != nil {
			return router.Change{}, err
		}
		if _, err := d.uci(ctx, "clear_rate_limit", "delete", map[string]any{"config": "nft-qos", "section": cfg.defaultID, "option": "nigafiy_enabled_mac"}); err != nil {
			return router.Change{}, err
		}
		disabled = "; nft-qos MAC-based limits turned off again (Nigafiy had turned them on)"
	}
	if err := d.commitQoS(ctx, "clear_rate_limit"); err != nil {
		return router.Change{}, err
	}
	cfg, _, err = d.nftQoS(ctx, "clear_rate_limit")
	if err != nil {
		return router.Change{}, err
	}
	if o, _ := cfg.forMAC(mac); o != "" {
		return router.Change{}, router.Errorf(router.ErrRejected, "clear_rate_limit", "nft-qos still lists the Nigafiy limit for %s", mac)
	}
	return router.Change{
		Action: "clear_rate_limit", MAC: mac, Mechanism: mechLimit, Applied: true,
		Detail: "deleted the Nigafiy nft-qos limit for " + mac + disabled,
		Undo:   "Set the limit again in Nigafiy",
	}, nil
}
