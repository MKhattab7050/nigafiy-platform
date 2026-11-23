package agent

import (
	"context"
	"encoding/hex"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/nigafiy/sensor/internal/cloud"
	"github.com/nigafiy/sensor/internal/mndp"
)

type mndpPacket struct {
	b   []byte
	src net.IP
}

type mndpConn struct {
	pkts   chan mndpPacket
	closed chan struct{}
}

func (c *mndpConn) ReadFrom(p []byte) (int, net.Addr, error) {
	select {
	case m := <-c.pkts:
		return copy(p, m.b), &net.UDPAddr{IP: m.src, Port: mndp.Port}, nil
	case <-c.closed:
		return 0, nil, net.ErrClosed
	}
}

func (c *mndpConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}

// The listener follows the site switch, accepts announcements only from authorized scopes, reports
// a bind failure without crashing, and uploads what it heard as an mndp_neighbors item.
func TestMNDPListenerFollowsSiteAndScopes(t *testing.T) {
	pkt, _ := hex.DecodeString("00000001" + "0001000648a98a010203" + "00050008" + hex.EncodeToString([]byte("hAP-desk")) + "001100040a0a0a01")
	conn := &mndpConn{pkts: make(chan mndpPacket, 4), closed: make(chan struct{})}
	fail := true
	deps := Deps{
		MNDPListen: ":5678",
		MNDPOpen: func(context.Context, string) (mndp.PacketConn, error) {
			if fail {
				return nil, errors.New("listen udp4 :5678: bind: address already in use")
			}
			return conn, nil
		},
	}
	a := smartAgent(t, deps)
	rc := &cloud.RemoteConfig{MNDP: &cloud.MNDPConfig{Enabled: true}}
	rc.Discovery.Scopes = []cloud.Scope{{ID: smartScopeID, CIDR: "10.10.10.0/24"}}
	a.mu.Lock()
	a.remote = rc
	a.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. Port in use: reported, not fatal, retried only after mndpRetry.
	a.applyMNDP(ctx)
	waitFor(t, "bind failure", func() bool { return a.mndpStatus().(mndp.Status).State == "bind_failed" })
	a.applyMNDP(ctx) // notices the ended listener; does not retry immediately
	if st := a.mndpStatus().(mndp.Status); st.State != "bind_failed" || st.Error == "" {
		t.Fatalf("status: %+v", st)
	}

	// 2. Port free again; after the retry delay the listener starts and receives.
	fail = false
	a.mndp.mu.Lock()
	a.mndp.failedAt = time.Time{}
	a.mndp.mu.Unlock()
	a.applyMNDP(ctx)
	waitFor(t, "listening", func() bool { return a.mndpStatus().(mndp.Status).State == "listening" })
	conn.pkts <- mndpPacket{pkt, net.ParseIP("10.10.10.1")}
	waitFor(t, "a neighbour", func() bool { return a.mndpStatus().(mndp.Status).Neighbors == 1 })
	conn.pkts <- mndpPacket{pkt, net.ParseIP("192.168.50.9")} // outside the authorized scope
	waitFor(t, "an out-of-scope drop", func() bool { return a.mndpStatus().(mndp.Status).OutOfScope == 1 })

	a.reportMNDP()
	items := a.queuedItems(t)
	if len(items) != 1 || items[0]["type"] != "mndp_neighbors" {
		t.Fatalf("items: %+v", items)
	}
	n := items[0]["neighbors"].([]any)[0].(map[string]any)
	if n["mac"] != "48:a9:8a:01:02:03" || n["identity"] != "hAP-desk" || n["ipv4"] != "10.10.10.1" || n["source_ip"] != "10.10.10.1" {
		t.Errorf("neighbour item: %+v", n)
	}

	// 3. The site turns it off: the socket is closed and the status says why.
	a.mu.Lock()
	a.remote.MNDP = &cloud.MNDPConfig{Enabled: false}
	a.mu.Unlock()
	a.applyMNDP(ctx)
	if st := a.mndpStatus().(mndp.Status); st.State != "disabled" || st.Error != "turned off for this site" {
		t.Errorf("status after turning off: %+v", st)
	}
	select {
	case <-conn.closed:
	default:
		t.Error("the socket must be closed when the site turns the listener off")
	}
}

func TestMNDPDisabledByLocalConfig(t *testing.T) {
	a := smartAgent(t, Deps{})
	a.mndpLoop(context.Background()) // returns at once
	if st := a.mndpStatus().(mndp.Status); st.State != "disabled" {
		t.Errorf("status: %+v", st)
	}
}
