// router-probe tries the router driver against a real router, run by the network's administrator.
//
// By default it is READ-ONLY: it identifies the router, lists its capabilities, every client it
// knows (with every raw field, so each value can be compared with the router's own web page) and
// every block in effect. With -block or -unblock it changes exactly one device, only after the
// administrator types that device's MAC address to confirm, and prints how to undo it.
//
// The admin password is asked for with a hidden prompt on the terminal. It cannot be given on the
// command line, in the environment or in a file, and it is never printed or logged.
//
//	router-probe -router 192.168.1.2
//	router-probe -router 192.168.1.2 -pin <sha256> -block aa:bb:cc:dd:ee:ff
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/nigafiy/sensor/internal/router"
	_ "github.com/nigafiy/sensor/internal/router/asus"
	_ "github.com/nigafiy/sensor/internal/router/ciscoxe"
	_ "github.com/nigafiy/sensor/internal/router/dlink"
	_ "github.com/nigafiy/sensor/internal/router/fortigate"
	_ "github.com/nigafiy/sensor/internal/router/huawei"
	_ "github.com/nigafiy/sensor/internal/router/huaweilte"
	_ "github.com/nigafiy/sensor/internal/router/mikrotik"
	_ "github.com/nigafiy/sensor/internal/router/omada"
	_ "github.com/nigafiy/sensor/internal/router/openwrt"
	_ "github.com/nigafiy/sensor/internal/router/opnsense"
	_ "github.com/nigafiy/sensor/internal/router/pfsense"
	_ "github.com/nigafiy/sensor/internal/router/tenda"
	_ "github.com/nigafiy/sensor/internal/router/tplink"
	_ "github.com/nigafiy/sensor/internal/router/unifi"
	_ "github.com/nigafiy/sensor/internal/router/zte"
	_ "github.com/nigafiy/sensor/internal/router/zyxel"
)

func main() {
	os.Exit(run())
}

func usage() {
	fmt.Fprintf(os.Stderr, `usage: router-probe -router <private IP> [-vendor %s] [-user admin]
                    [-transport https-pinned|https|http] [-pin <sha256>] [-port N]
                    [-block <MAC> | -unblock <MAC>]

Read-only unless -block or -unblock is given. The password is prompted for on the terminal.
`, strings.Join(router.Vendors(), "|"))
	flag.PrintDefaults()
}

func run() int {
	addrFlag := flag.String("router", "", "router IP address (private ranges only)")
	vendor := flag.String("vendor", "zyxel", "driver: "+strings.Join(router.Vendors(), ", "))
	user := flag.String("user", "admin", "router administrator user name")
	transport := flag.String("transport", string(router.TransportHTTPSPinned),
		"https-pinned (default: trust the router's own certificate by fingerprint), https (system-trusted certificate), http (unencrypted, explicit opt-in)")
	pin := flag.String("pin", "", "SHA-256 fingerprint of the router certificate (https-pinned); asked for interactively when empty")
	port := flag.Int("port", 0, "management port (default 443, or 80 for http)")
	block := flag.String("block", "", "turn on blocking for this MAC address (asks for confirmation)")
	unblock := flag.String("unblock", "", "turn off blocking for this MAC address (asks for confirmation)")
	timeout := flag.Duration("timeout", 15*time.Second, "per-request timeout")
	flag.Usage = usage
	flag.Parse()
	if flag.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "unexpected arguments:", flag.Args(), "(the password is never taken from the command line)")
		return 2
	}
	if *block != "" && *unblock != "" {
		fmt.Fprintln(os.Stderr, "use -block or -unblock, not both")
		return 2
	}

	addr, err := netip.ParseAddr(strings.TrimSpace(*addrFlag))
	if err != nil {
		usage()
		return 2
	}
	addr = addr.Unmap()
	if !router.IsPrivate(addr) {
		fmt.Fprintf(os.Stderr, "refusing %s: only routers on private (RFC 1918) addresses can be probed\n", addr)
		return 2
	}
	// The administrator running this tool is the authority for this one address.
	opts := router.Options{Authorized: []netip.Prefix{netip.PrefixFrom(addr, 32)}}

	var actionMAC string
	if m := *block + *unblock; m != "" {
		if actionMAC, err = router.NormalizeMAC(m); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
	}

	term, err := openTerminal()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer term.in.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	tg := router.Target{ID: "probe", Vendor: *vendor, Address: addr, Port: *port, Transport: router.Transport(*transport), PinSHA256: *pin, Timeout: *timeout}
	switch tg.Transport {
	case router.TransportHTTPSPinned:
		if tg.PinSHA256 == "" {
			p, ok := trustOnFirstUse(ctx, term, addr, *port, opts)
			if !ok {
				return 1
			}
			tg.PinSHA256 = p
		}
	case router.TransportHTTP:
		fmt.Println("WARNING: plain HTTP selected. The login is still RSA/AES-encrypted by the router's own scheme,")
		fmt.Println("         but the session cookie crosses the LAN unencrypted. Prefer -transport https-pinned.")
	}

	var password []byte // kept only for this run (a re-login after a session expiry needs it), zeroed at exit
	defer func() { router.Zero(password) }()
	creds := func(context.Context) (string, []byte, error) {
		if password == nil {
			p, err := term.Secret(fmt.Sprintf("Password for %s on %s (input hidden): ", *user, addr))
			if err != nil {
				return "", nil, err
			}
			if len(p) == 0 {
				return "", nil, errors.New("empty password")
			}
			password = p
		}
		return *user, append([]byte(nil), password...), nil
	}

	d, err := router.Open(tg, creds, opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open the router:", err)
		return 1
	}
	defer func() {
		if err := d.Close(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "logout:", err)
		} else {
			fmt.Println("\nLogged out.")
		}
	}()

	if actionMAC == "" {
		fmt.Println("READ-ONLY MODE: nothing on the router will be changed.")
	}
	if code := readOnly(ctx, d); code != 0 {
		return code
	}
	if actionMAC == "" {
		fmt.Println("\nCompare every value above with the router's own web pages before relying on this driver.")
		return 0
	}
	return change(ctx, d, term, actionMAC, *block != "")
}

func trustOnFirstUse(ctx context.Context, term *terminal, addr netip.Addr, port int, opts router.Options) (string, bool) {
	ci, err := router.FetchCertificate(ctx, addr, port, opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read the router's certificate:", err)
		return "", false
	}
	fmt.Println("The router presents this TLS certificate:")
	fmt.Printf("  subject      %s\n  issuer       %s\n  valid        %s .. %s\n", ci.Subject, ci.Issuer,
		ci.NotBefore.Format("2006-01-02"), ci.NotAfter.Format("2006-01-02"))
	fmt.Printf("  self-signed  %v   expired %v   trusted by this system %v\n", ci.SelfSigned, ci.Expired, ci.SystemTrust)
	fmt.Printf("  SHA-256      %s\n", ci.SHA256)
	fmt.Println("Only trust it if you are on your own network and this is your router.")
	ans, err := term.Line("Type 'trust' to pin this certificate for this run: ")
	if err != nil || ans != "trust" {
		fmt.Println("Not trusted; nothing was sent to the router.")
		return "", false
	}
	fmt.Printf("Pinned. Next time add:  -pin %s\n\n", strings.ReplaceAll(ci.SHA256, ":", ""))
	return ci.SHA256, true
}

func printErr(what string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", what, err)
	if errors.Is(err, router.ErrLockedOut) {
		fmt.Fprintln(os.Stderr, "The router locked logins after failed attempts; wait before trying again.")
	}
}

func readOnly(ctx context.Context, d router.Driver) int {
	info, err := d.Identify(ctx)
	if err != nil {
		printErr("identify", err)
		return 1
	}
	fmt.Printf("\n== Router\nvendor    %s\nmodel     %s\nfirmware  %s\n", info.Vendor, info.Model, info.Firmware)
	for k, v := range info.Extra {
		fmt.Printf("%-9s %s\n", k, v)
	}

	caps, err := d.Capabilities(ctx) // first call that logs in
	if err != nil {
		printErr("capabilities", err)
		return 1
	}
	fmt.Println("\n== Capabilities")
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	for _, c := range caps {
		yes := "no"
		if c.Supported {
			yes = "yes"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", c.Capability, yes, c.Mechanism, c.Note)
	}
	tw.Flush()

	clients, err := d.Clients(ctx)
	if err != nil {
		printErr("clients", err)
		return 1
	}
	fmt.Printf("\n== Clients (%d) as the router lists them\n", len(clients))
	tw = tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MAC\tIP\tNAME\tCONNECTION\tSIGNAL\tACTIVE\tLEASE\tBLOCKED")
	for _, c := range clients {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", c.MAC, c.IP, c.Hostname, c.Connection,
			optInt(c.SignalDBm, " dBm"), optBool(c.Active), lease(c.Lease), optBool(c.Blocked))
	}
	tw.Flush()
	fmt.Println("\n-- Every field the router returned, per client (for comparison with its web page)")
	for _, c := range clients {
		fmt.Printf("%s\n", c.MAC)
		keys := make([]string, 0, len(c.Raw))
		for k := range c.Raw {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Printf("    %-28s %s\n", k, c.Raw[k])
		}
	}

	if !caps.Supports(router.CapBlock) {
		fmt.Println("\n== Blocked: blocking is not supported here (see capabilities)")
	}
	blocked, err := d.Blocked(ctx)
	if err != nil {
		printErr("blocked", err)
		return 1
	}
	printBlocked(blocked)

	if sr, ok := d.(router.SettingsReader); ok {
		settings, err := sr.Settings(ctx)
		if err != nil {
			printErr("settings", err)
		} else {
			printSettings(settings)
		}
	}
	return 0
}

func printSettings(s router.Settings) {
	if s.Overview != nil {
		fmt.Println("\n== Overview")
		if s.Overview.LANIP != "" {
			fmt.Printf("LAN IP    %s\n", s.Overview.LANIP)
		}
		if s.Overview.UptimeSeconds != nil {
			fmt.Printf("Uptime    %s\n", (time.Duration(*s.Overview.UptimeSeconds) * time.Second).String())
		}
		for _, w := range s.Overview.WAN {
			fmt.Printf("WAN       %s  status=%s  type=%s  ip=%s  dns=%s\n", w.Name, w.Status, w.Type, w.IPv4, strings.Join(w.DNS, ","))
		}
	}
	if len(s.WiFi) > 0 {
		fmt.Printf("\n== Wi-Fi networks (%d)\n", len(s.WiFi))
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tBAND\tSSID\tENABLED\tGUEST\tHIDDEN\tSECURITY\tCLIENTS")
		for _, w := range s.WiFi {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%v\t%v\t%v\t%s\t%d\n", w.ID, w.Band, w.SSID, w.Enabled, w.Guest, w.Hidden, w.Security, len(w.ClientMACs))
		}
		tw.Flush()
	}
	if len(s.Reservations) > 0 {
		fmt.Printf("\n== DHCP reservations (%d)\n", len(s.Reservations))
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tMAC\tIP\tENABLED")
		for _, r := range s.Reservations {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%v\n", r.ID, r.MAC, r.IP, r.Enabled)
		}
		tw.Flush()
	}
	if len(s.PortForwards) > 0 {
		fmt.Printf("\n== Port forwards (%d)\n", len(s.PortForwards))
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tPROTO\tEXTERNAL\tINTERNAL\tOWNER\tDESCRIPTION")
		for _, p := range s.PortForwards {
			fmt.Fprintf(tw, "%s\t%s\t%d-%d\t%s:%d-%d\t%s\t%s\n", p.ID, p.Protocol, p.ExternalStart, p.ExternalEnd, p.InternalIP, p.InternalStart, p.InternalEnd, p.Owner, p.Description)
		}
		tw.Flush()
	}
}

func printBlocked(blocked []router.BlockEntry) {
	fmt.Printf("\n== Blocks in effect (%d)\n", len(blocked))
	if len(blocked) == 0 {
		fmt.Println("(none)")
		return
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MAC\tNAME\tMECHANISM\tOWNER\tPARTIAL\tMANAGED\tDETAIL")
	for _, b := range blocked {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%v\t%v\t%s\n", b.MAC, b.Name, b.Mechanism, b.Owner, b.Partial, b.Managed, b.Detail)
	}
	tw.Flush()
}

func change(ctx context.Context, d router.Driver, term *terminal, mac string, block bool) int {
	action := "UNBLOCK"
	if block {
		action = "BLOCK"
		if own := localMACs(); own[mac] {
			fmt.Fprintf(os.Stderr, "refusing to block %s: it is a network adapter of this computer\n", mac)
			return 2
		}
	}
	fmt.Printf("\n== Requested change: %s %s\n", action, mac)
	if block {
		fmt.Println("The router's per-device Internet Blocking switch will be turned ON for this device.")
		fmt.Println("It loses internet access; it stays on the local network. No other rule is touched.")
	} else {
		fmt.Println("The router's per-device Internet Blocking switch will be turned OFF for this device.")
		fmt.Println("Only do this for a device you (or LAN Detective) blocked; the router cannot tell who did.")
	}
	ans, err := term.Line(fmt.Sprintf("Type the MAC address (%s) to confirm, anything else cancels: ", mac))
	if err != nil {
		return 1
	}
	if got, err := router.NormalizeMAC(ans); err != nil || got != mac {
		fmt.Println("Cancelled; nothing was changed.")
		return 1
	}
	var ch router.Change
	if block {
		ch, err = d.Block(ctx, mac)
	} else {
		ch, err = d.Unblock(ctx, mac)
	}
	if err != nil {
		printErr(strings.ToLower(action), err)
		fmt.Println("Nothing was changed by this request, unless the router reported a partial success above.")
		return 1
	}
	fmt.Println("\n== Result")
	if ch.Applied {
		fmt.Println("CHANGED:", ch.Detail)
		fmt.Println("mechanism:", ch.Mechanism)
		fmt.Println("UNDO:", ch.Undo)
	} else {
		fmt.Println("NO CHANGE:", ch.Detail)
	}
	if blocked, err := d.Blocked(ctx); err == nil {
		printBlocked(blocked)
	}
	return 0
}

func localMACs() map[string]bool {
	out := map[string]bool{}
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if m, err := router.NormalizeMAC(i.HardwareAddr.String()); err == nil {
			out[m] = true
		}
	}
	return out
}

func optBool(b *bool) string {
	if b == nil {
		return "-"
	}
	if *b {
		return "yes"
	}
	return "no"
}

func optInt(v *int, unit string) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%d%s", *v, unit)
}

func lease(l *router.Lease) string {
	if l == nil {
		return "-"
	}
	s := l.Source
	if l.Remaining != nil {
		s += " " + l.Remaining.String()
	}
	return strings.TrimSpace(s)
}
