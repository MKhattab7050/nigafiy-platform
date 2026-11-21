package identify

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

var mdnsGroup = &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}

const (
	serviceEnumeration = "_services._dns-sd._udp.local."
	// "QU" bit: ask for a unicast reply to our port, so we never need to join the multicast group.
	classUnicastINET = dnsmessage.Class(0x8001)
	questionsPerMsg  = 16
)

// TXT keys worth keeping: they carry model / type / friendly-name information.
var txtKeys = map[string]string{
	"model": "model", "md": "model", "am": "model", "usb_mdl": "model", "ty": "product",
	"fn": "friendly_name", "n": "friendly_name", "usb_mfg": "manufacturer", "manufacturer": "manufacturer", "mf": "manufacturer",
}

func buildQueries(names []string) [][]byte {
	var out [][]byte
	for start := 0; start < len(names); start += questionsPerMsg {
		end := min(start+questionsPerMsg, len(names))
		b := dnsmessage.NewBuilder(nil, dnsmessage.Header{})
		b.EnableCompression()
		if b.StartQuestions() != nil {
			continue
		}
		for _, n := range names[start:end] {
			name, err := dnsmessage.NewName(n)
			if err != nil {
				continue
			}
			_ = b.Question(dnsmessage.Question{Name: name, Type: dnsmessage.TypePTR, Class: classUnicastINET})
		}
		if msg, err := b.Finish(); err == nil {
			out = append(out, msg)
		}
	}
	return out
}

func reverseName(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil || !addr.Is4() {
		return ""
	}
	a := addr.As4()
	return fmt.Sprintf("%d.%d.%d.%d.in-addr.arpa.", a[3], a[2], a[1], a[0])
}

// parseMDNS records what one mDNS response from `src` says, and returns the service types it listed.
func parseMDNS(c *collector, src string, msg []byte) (serviceTypes []string) {
	var p dnsmessage.Parser
	if _, err := p.Start(msg); err != nil {
		return nil
	}
	if p.SkipAllQuestions() != nil {
		return nil
	}
	var records []dnsmessage.Resource
	if rs, err := p.AllAnswers(); err == nil || len(rs) > 0 {
		records = append(records, rs...)
	}
	if rs, err := p.AllAuthorities(); err == nil || len(rs) > 0 {
		records = append(records, rs...)
	}
	if rs, err := p.AllAdditionals(); err == nil || len(rs) > 0 {
		records = append(records, rs...)
	}
	for _, r := range records {
		owner := r.Header.Name.String()
		switch body := r.Body.(type) {
		case *dnsmessage.PTRResource:
			target := body.PTR.String()
			switch {
			case strings.EqualFold(owner, serviceEnumeration):
				serviceTypes = append(serviceTypes, target)
				c.addService(src, target)
			case strings.HasSuffix(owner, ".in-addr.arpa."):
				c.addName(src, "mdns", target)
			case strings.HasPrefix(owner, "_"):
				c.addService(src, owner)
				// "Living Room TV._airplay._tcp.local." → instance label "Living Room TV"
				if instance := strings.TrimSuffix(target, "."+owner); instance != target {
					c.addName(src, "mdns", strings.ReplaceAll(instance, `\`, ""))
				}
			}
		case *dnsmessage.SRVResource:
			c.addName(src, "mdns", body.Target.String())
		case *dnsmessage.AResource:
			if netip.AddrFrom4(body.A).String() == src {
				c.addName(src, "mdns", owner)
			}
		case *dnsmessage.TXTResource:
			for _, kv := range body.TXT {
				key, value, ok := strings.Cut(kv, "=")
				if !ok {
					continue
				}
				if hint, keep := txtKeys[strings.ToLower(key)]; keep {
					c.addHint(src, hint, value)
				}
			}
		}
	}
	return serviceTypes
}

func probeMDNS(ctx context.Context, c *collector, hosts []string, local net.IP) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: local, Port: 0})
	if err != nil {
		return
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	send := func(names []string) {
		for _, msg := range buildQueries(names) {
			_, _ = conn.WriteToUDP(msg, mdnsGroup)
		}
	}
	// Round 1: "which services exist?" plus "what is the name of each address we found?".
	first := []string{serviceEnumeration}
	for _, ip := range hosts {
		if n := reverseName(ip); n != "" {
			first = append(first, n)
		}
	}
	send(first)
	types := map[string]bool{}
	read := func(d time.Duration) {
		deadline := time.Now().Add(d)
		buf := make([]byte, 9000)
		for ctx.Err() == nil {
			_ = conn.SetReadDeadline(deadline)
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			for _, t := range parseMDNS(c, from.IP.String(), buf[:n]) {
				types[t] = true
			}
		}
	}
	read(1500 * time.Millisecond)
	// Round 2: for every advertised service type, ask who offers it (answers carry names and models).
	var second []string
	for t := range types {
		if len(second) < 64 {
			second = append(second, t)
		}
	}
	if len(second) > 0 && ctx.Err() == nil {
		send(second)
		read(2 * time.Second)
	}
}
