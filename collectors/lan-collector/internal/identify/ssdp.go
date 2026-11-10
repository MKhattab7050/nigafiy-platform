package identify

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"sync"
	"time"
)

var ssdpGroup = &net.UDPAddr{IP: net.IPv4(239, 255, 255, 250), Port: 1900}

const ssdpSearch = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n"

type ssdpReply struct {
	Server, ST, Location string
}

// parseSSDP reads one SSDP search response.
func parseSSDP(msg []byte) (ssdpReply, bool) {
	r := textproto.NewReader(bufio.NewReader(bytes.NewReader(msg)))
	status, err := r.ReadLine()
	if err != nil || !strings.HasPrefix(status, "HTTP/1.1 200") {
		return ssdpReply{}, false
	}
	h, _ := r.ReadMIMEHeader()
	return ssdpReply{Server: h.Get("Server"), ST: h.Get("St"), Location: h.Get("Location")}, true
}

// deviceTypeOf extracts "MediaRenderer" from "urn:schemas-upnp-org:device:MediaRenderer:1".
func deviceTypeOf(st string) string {
	parts := strings.Split(st, ":")
	for i, p := range parts {
		if p == "device" && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}

type upnpDescription struct {
	Device struct {
		DeviceType   string `xml:"deviceType"`
		FriendlyName string `xml:"friendlyName"`
		Manufacturer string `xml:"manufacturer"`
		ModelName    string `xml:"modelName"`
	} `xml:"device"`
}

func parseDescription(body []byte) (upnpDescription, bool) {
	var d upnpDescription
	if err := xml.Unmarshal(body, &d); err != nil {
		return d, false
	}
	return d, d.Device.FriendlyName != "" || d.Device.ModelName != "" || d.Device.Manufacturer != ""
}

func probeSSDP(ctx context.Context, c *collector, local net.IP) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: local, Port: 0})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.WriteToUDP([]byte(ssdpSearch), ssdpGroup)

	locations := map[string]string{} // ip → description URL
	deadline := time.Now().Add(3 * time.Second)
	buf := make([]byte, 4096)
	for ctx.Err() == nil {
		_ = conn.SetReadDeadline(deadline)
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			break
		}
		reply, ok := parseSSDP(buf[:n])
		if !ok {
			continue
		}
		ip := from.IP.String()
		c.ssdp(ip, func(s *SSDP) {
			if s.Server == "" {
				s.Server = Clean(reply.Server)
			}
			if t := Clean(deviceTypeOf(reply.ST)); t != "" && len(s.DeviceTypes) < 8 {
				for _, existing := range s.DeviceTypes {
					if existing == t {
						return
					}
				}
				s.DeviceTypes = append(s.DeviceTypes, t)
			}
		})
		// Only fetch a description the device hosts itself: never follow a pointer to another address.
		if u, err := url.Parse(reply.Location); err == nil && u.Scheme == "http" && u.Hostname() == ip {
			if _, seen := locations[ip]; !seen {
				locations[ip] = reply.Location
			}
		}
	}

	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for ip, location := range locations {
		if c.inScope(ip) == false {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(ip, location string) {
			defer wg.Done()
			defer func() { <-sem }()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
			if err != nil {
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 128<<10))
			if d, ok := parseDescription(body); ok {
				c.ssdp(ip, func(s *SSDP) {
					s.FriendlyName, s.Manufacturer, s.Model = Clean(d.Device.FriendlyName), Clean(d.Device.Manufacturer), Clean(d.Device.ModelName)
				})
				c.addName(ip, "ssdp", d.Device.FriendlyName)
			}
		}(ip, location)
	}
	wg.Wait()
}

func (c *collector) inScope(ip string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.get(ip) != nil
}

// ── NetBIOS node status (what `nbtstat -A` sends) ──

func nbstatQuery(id uint16) []byte {
	q := make([]byte, 0, 50)
	q = binary.BigEndian.AppendUint16(q, id)
	q = append(q, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0) // flags, QDCOUNT=1
	q = append(q, 0x20)
	q = append(q, "CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"...) // encoded "*"
	q = append(q, 0, 0, 0x21, 0, 0x01)                   // NBSTAT, IN
	return q
}

// parseNBStat returns the machine name from a node status response ("" if none).
func parseNBStat(msg []byte) string {
	const header, rrFixed = 12, 34 + 2 + 2 + 4 + 2
	if len(msg) < header+rrFixed+1 {
		return ""
	}
	count := int(msg[header+rrFixed])
	entries := msg[header+rrFixed+1:]
	for i := 0; i < count && len(entries) >= (i+1)*18; i++ {
		e := entries[i*18 : (i+1)*18]
		suffix, flags := e[15], binary.BigEndian.Uint16(e[16:18])
		// suffix 0x00 = workstation service; group bit clear = a unique (machine) name.
		if suffix == 0x00 && flags&0x8000 == 0 {
			return Clean(strings.TrimRight(string(e[:15]), " \x00"))
		}
	}
	return ""
}

func probeNetBIOS(ctx context.Context, c *collector, hosts []string) {
	if len(hosts) == 0 {
		return
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return
	}
	defer conn.Close()
	for i, ip := range hosts {
		if addr := net.ParseIP(ip); addr != nil {
			_, _ = conn.WriteToUDP(nbstatQuery(uint16(i+1)), &net.UDPAddr{IP: addr, Port: 137})
			time.Sleep(10 * time.Millisecond) // pace: at most 100 small packets per second
		}
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	buf := make([]byte, 2048)
	for ctx.Err() == nil {
		_ = conn.SetReadDeadline(deadline)
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if name := parseNBStat(buf[:n]); name != "" {
			c.addName(from.IP.String(), "netbios", name)
		}
	}
}
