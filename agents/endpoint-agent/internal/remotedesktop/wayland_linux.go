//go:build linux

package remotedesktop

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

const (
	portalBus  = "org.freedesktop.portal.Desktop"
	portalPath = dbus.ObjectPath("/org/freedesktop/portal/desktop")
	// The user answers the portal's dialog; a frame or an input event waits at most this long.
	portalAnswerTimeout = 2 * time.Minute
)

func isWayland() bool { return Backend() == "wayland-portal" }

func platformCapture() (*image.RGBA, string, bool, error) {
	if !isWayland() {
		return nil, "", false, nil
	}
	img, err := theWayland.screenshot()
	return img, "wayland_portal", true, err
}

func platformInput(ev InputEvent) (bool, error) {
	if !isWayland() {
		return false, nil
	}
	return true, theWayland.input(ev)
}

type wayland struct {
	mu      sync.Mutex
	conn    *dbus.Conn
	session dbus.ObjectPath
	stream  portalStream
}

var theWayland = &wayland{}

func token() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "nigafiy" + hex.EncodeToString(b[:])
}

func (w *wayland) bus() (*dbus.Conn, error) {
	if w.conn != nil && w.conn.Connected() {
		return w.conn, nil
	}
	c, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("the desktop session bus is not reachable (DBUS_SESSION_BUS_ADDRESS): %w", err)
	}
	w.conn, w.session = c, ""
	return c, nil
}

// request makes one portal call that answers through a Request object and waits for its
// Response signal.
func (w *wayland) request(c *dbus.Conn, method string, args func(tok string) []any) (map[string]dbus.Variant, error) {
	tok := token()
	sender := strings.ReplaceAll(strings.TrimPrefix(c.Names()[0], ":"), ".", "_")
	want := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + sender + "/" + tok)
	if err := c.AddMatchSignal(dbus.WithMatchObjectPath(want), dbus.WithMatchInterface("org.freedesktop.portal.Request"), dbus.WithMatchMember("Response")); err != nil {
		return nil, err
	}
	defer func() {
		_ = c.RemoveMatchSignal(dbus.WithMatchObjectPath(want), dbus.WithMatchInterface("org.freedesktop.portal.Request"), dbus.WithMatchMember("Response"))
	}()
	ch := make(chan *dbus.Signal, 8)
	c.Signal(ch)
	defer c.RemoveSignal(ch)

	var handle dbus.ObjectPath
	if err := c.Object(portalBus, portalPath).Call(method, 0, args(tok)...).Store(&handle); err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	timeout := time.After(portalAnswerTimeout)
	for {
		select {
		case s := <-ch:
			if s.Name != "org.freedesktop.portal.Request.Response" || (s.Path != handle && s.Path != want) || len(s.Body) < 2 {
				continue
			}
			code, _ := s.Body[0].(uint32)
			if err := portalResponseError(code); err != nil {
				return nil, err
			}
			res, _ := s.Body[1].(map[string]dbus.Variant)
			return res, nil
		case <-timeout:
			return nil, errors.New("nobody answered the desktop portal's dialog")
		}
	}
}

func opts(tok string, kv ...any) map[string]dbus.Variant {
	m := map[string]dbus.Variant{"handle_token": dbus.MakeVariant(tok)}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i].(string)] = dbus.MakeVariant(kv[i+1])
	}
	return m
}

func (w *wayland) screenshot() (*image.RGBA, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, err := w.bus()
	if err != nil {
		return nil, err
	}
	res, err := w.request(c, "org.freedesktop.portal.Screenshot.Screenshot", func(tok string) []any {
		return []any{"", opts(tok, "interactive", false)}
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errNoDesktop, err)
	}
	uri, _ := res["uri"].Value().(string)
	path, err := fileURIPath(uri)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	// The portal saved it in the user's pictures folder; it is ours, not the user's.
	_ = os.Remove(path)
	if err != nil {
		return nil, err
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("screenshot could not be decoded: %v", err)
	}
	b := src.Bounds()
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(rgba, rgba.Bounds(), src, b.Min, draw.Src)
	return rgba, nil
}

// ensureSession starts a RemoteDesktop session with keyboard + pointer and one monitor stream.
// The portal shows the user its own "allow remote interaction" dialog at Start.
func (w *wayland) ensureSession() (*dbus.Conn, error) {
	c, err := w.bus()
	if err != nil {
		return nil, err
	}
	if w.session != "" {
		return c, nil
	}
	res, err := w.request(c, "org.freedesktop.portal.RemoteDesktop.CreateSession", func(tok string) []any {
		return []any{opts(tok, "session_handle_token", token())}
	})
	if err != nil {
		return nil, err
	}
	sp, _ := res["session_handle"].Value().(string)
	if sp == "" {
		return nil, errors.New("the portal created no session")
	}
	session := dbus.ObjectPath(sp)
	if _, err := w.request(c, "org.freedesktop.portal.RemoteDesktop.SelectDevices", func(tok string) []any {
		return []any{session, opts(tok, "types", uint32(1|2))} // keyboard | pointer
	}); err != nil {
		return nil, err
	}
	if _, err := w.request(c, "org.freedesktop.portal.ScreenCast.SelectSources", func(tok string) []any {
		return []any{session, opts(tok, "types", uint32(1), "multiple", false)} // one monitor
	}); err != nil {
		return nil, err
	}
	res, err = w.request(c, "org.freedesktop.portal.RemoteDesktop.Start", func(tok string) []any {
		return []any{session, "", opts(tok)}
	})
	if err != nil {
		return nil, err
	}
	streams, err := parsePortalStreams(res["streams"])
	if err != nil {
		return nil, err
	}
	w.session, w.stream = session, streams[0]
	return c, nil
}

func (w *wayland) input(ev InputEvent) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	err := w.inject(ev)
	if err != nil && w.session != "" && !errors.Is(err, errBadInput) {
		// The session may have been closed (the user stopped sharing): start over once.
		w.session = ""
		err = w.inject(ev)
	}
	return err
}

var errBadInput = errors.New("input not supported")

func (w *wayland) inject(ev InputEvent) error {
	c, err := w.ensureSession()
	if err != nil {
		return err
	}
	rd := c.Object(portalBus, portalPath)
	none := map[string]dbus.Variant{}
	call := func(method string, args ...any) error {
		return rd.Call("org.freedesktop.portal.RemoteDesktop."+method, 0, append([]any{w.session, none}, args...)...).Err
	}
	move := func() error {
		x := clamp01(ev.NormalizedX) * float64(w.stream.Width)
		y := clamp01(ev.NormalizedY) * float64(w.stream.Height)
		return call("NotifyPointerMotionAbsolute", w.stream.Node, x, y)
	}
	button := func(state uint32) error { return call("NotifyPointerButton", evdevButton(ev.Button), state) }
	keysym := func(ks int32, state uint32) error { return call("NotifyKeyboardKeysym", ks, state) }

	switch ev.Kind {
	case "mouse_move":
		return move()
	case "mouse_down", "mouse_up":
		if err := move(); err != nil {
			return err
		}
		if ev.Kind == "mouse_down" {
			return button(1)
		}
		return button(0)
	case "mouse_click":
		if err := move(); err != nil {
			return err
		}
		for i := 0; i < map[bool]int{false: 1, true: 2}[ev.Double]; i++ {
			if err := button(1); err != nil {
				return err
			}
			if err := button(0); err != nil {
				return err
			}
		}
		return nil
	case "mouse_wheel":
		if err := move(); err != nil {
			return err
		}
		return call("NotifyPointerAxisDiscrete", uint32(0), wheelSteps(ev.DeltaY))
	case "key_press":
		ks, ok := keyKeysym(ev.Key)
		if !ok {
			return fmt.Errorf("%w: unsupported key %s", errBadInput, ev.Key)
		}
		var mods []int32
		if ev.Ctrl {
			mods = append(mods, keysymControlL)
		}
		if ev.Alt {
			mods = append(mods, keysymAltL)
		}
		if ev.Shift {
			mods = append(mods, keysymShiftL)
		}
		for _, m := range mods {
			if err := keysym(m, 1); err != nil {
				return err
			}
		}
		err := keysym(ks, 1)
		if err == nil {
			err = keysym(ks, 0)
		}
		for i := len(mods) - 1; i >= 0; i-- {
			_ = keysym(mods[i], 0)
		}
		return err
	case "text":
		for _, r := range ev.Text {
			ks, ok := runeKeysym(r)
			if !ok {
				continue
			}
			if err := keysym(ks, 1); err != nil {
				return err
			}
			if err := keysym(ks, 0); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("%w: unknown input event kind %s", errBadInput, ev.Kind)
}
