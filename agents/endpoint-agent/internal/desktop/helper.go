package desktop

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/userui"
)

// Session helper protocol. Each message: uint32 BE total length | uint32 BE JSON length | JSON |
// binary data (only frames carry data). Requests {"id","m","p"}, responses {"id","r","e"}, events
// from the helper {"ev":"banner_end","s":<session>}.

const maxHelperMessage = 64 << 20

type wireMsg struct {
	ID     uint64          `json:"id,omitempty"`
	Method string          `json:"m,omitempty"`
	Params json.RawMessage `json:"p,omitempty"`
	Result json.RawMessage `json:"r,omitempty"`
	Error  string          `json:"e,omitempty"`
	Event  string          `json:"ev,omitempty"`
	Sess   string          `json:"s,omitempty"`
}

func writeMsg(w io.Writer, m wireMsg, data []byte) error {
	js, err := json.Marshal(m)
	if err != nil {
		return err
	}
	total := 4 + len(js) + len(data)
	if total > maxHelperMessage {
		return errors.New("helper message too large")
	}
	buf := make([]byte, 0, 4+total)
	buf = binary.BigEndian.AppendUint32(buf, uint32(total))
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(js)))
	buf = append(buf, js...)
	buf = append(buf, data...)
	_, err = w.Write(buf)
	return err
}

func readMsg(r io.Reader) (wireMsg, []byte, error) {
	var hdr [8]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return wireMsg{}, nil, err
	}
	total := binary.BigEndian.Uint32(hdr[:4])
	jlen := binary.BigEndian.Uint32(hdr[4:])
	if total < 4 || total > maxHelperMessage || jlen > total-4 {
		return wireMsg{}, nil, errors.New("bad helper message length")
	}
	body := make([]byte, total-4)
	if _, err := io.ReadFull(r, body); err != nil {
		return wireMsg{}, nil, err
	}
	var m wireMsg
	if err := json.Unmarshal(body[:jlen], &m); err != nil {
		return wireMsg{}, nil, err
	}
	return m, body[jlen:], nil
}

// ---------------------------------------------------------------------------------------------
// Helper side

type streamParams struct {
	Stream string                    `json:"stream"`
	Req    remotedesktop.GrabRequest `json:"req"`
}

type bannerParams struct {
	Info userui.BannerInfo `json:"info"`
}

// Serve answers requests from the parent until rw closes. Input events are applied in arrival
// order (mouse down before up); everything else runs concurrently (a consent dialog waits for the
// person while frames keep flowing).
func Serve(ctx context.Context, r io.Reader, w io.Writer, d Desktop) error {
	var wmu sync.Mutex
	send := func(m wireMsg, data []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = writeMsg(w, m, data)
	}
	d.SetToolEvents(func(ev ToolEvent, data []byte) {
		raw, _ := json.Marshal(ev)
		send(wireMsg{Event: "tool", Result: raw}, data)
	})
	defer d.Tool(context.Background(), ToolRequest{Op: ToolEndAllForSess}, nil) //nolint:errcheck // best effort at exit
	reply := func(id uint64, v any, data []byte, err error) {
		m := wireMsg{ID: id}
		if err != nil {
			m.Error = err.Error()
		} else if v != nil {
			m.Result, _ = json.Marshal(v)
		}
		send(m, data)
	}
	for {
		m, data, err := readMsg(r)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return nil
			}
			return err
		}
		if m.Method == "input" {
			var ev remotedesktop.InputEvent
			if err := json.Unmarshal(m.Params, &ev); err != nil {
				reply(m.ID, nil, nil, err)
				continue
			}
			reply(m.ID, nil, nil, d.Input(ev))
			continue
		}
		go func(m wireMsg) {
			switch m.Method {
			case "ping":
				reply(m.ID, "pong", nil, nil)
			case "info":
				reply(m.ID, d.Info(), nil, nil)
			case "displays":
				v, err := d.Displays()
				reply(m.ID, v, nil, err)
			case "capture":
				var opts remotedesktop.CaptureOptions
				_ = json.Unmarshal(m.Params, &opts)
				v, err := d.CaptureFrame(opts)
				reply(m.ID, v, nil, err)
			case "grab":
				var p streamParams
				_ = json.Unmarshal(m.Params, &p)
				f, err := d.Grab(p.Stream, p.Req)
				if err != nil || f == nil {
					reply(m.ID, nil, nil, err)
					return
				}
				reply(m.ID, f.Header, f.Data, nil)
			case "reset":
				var p streamParams
				_ = json.Unmarshal(m.Params, &p)
				d.ResetStream(p.Stream)
				reply(m.ID, nil, nil, nil)
			case "end_stream":
				var p streamParams
				_ = json.Unmarshal(m.Params, &p)
				d.EndStream(p.Stream)
				reply(m.ID, nil, nil, nil)
			case "consent":
				var req userui.ConsentRequest
				_ = json.Unmarshal(m.Params, &req)
				a, err := d.Consent(ctx, req)
				reply(m.ID, a, nil, err)
			case "banner_show":
				var p bannerParams
				_ = json.Unmarshal(m.Params, &p)
				sess := p.Info.SessionID
				err := d.ShowBanner(p.Info, func() { send(wireMsg{Event: "banner_end", Sess: sess}, nil) })
				reply(m.ID, nil, nil, err)
			case "banner_hide":
				var p bannerParams
				_ = json.Unmarshal(m.Params, &p)
				d.HideBanner(p.Info.SessionID)
				reply(m.ID, nil, nil, nil)
			case "tool":
				var req ToolRequest
				if err := json.Unmarshal(m.Params, &req); err != nil {
					reply(m.ID, nil, nil, err)
					return
				}
				res, out, err := d.Tool(ctx, req, data)
				reply(m.ID, res, out, err)
			case "clip_get":
				s, err := d.ClipboardText()
				reply(m.ID, s, nil, err)
			case "clip_set":
				var s string
				_ = json.Unmarshal(m.Params, &s)
				reply(m.ID, nil, nil, d.SetClipboardText(s))
			default:
				if serveVideo(d, m.Method, m.Params, func(v any, data []byte, err error) { reply(m.ID, v, data, err) }) {
					return
				}
				reply(m.ID, nil, nil, fmt.Errorf("unknown helper method %q", m.Method))
			}
		}(m)
	}
}

// ---------------------------------------------------------------------------------------------
// Parent side

type response struct {
	m    wireMsg
	data []byte
}

// HelperClient is the parent's view of one running helper.
type HelperClient struct {
	rwc     io.ReadWriteCloser
	wmu     sync.Mutex
	mu      sync.Mutex
	next    uint64
	pending map[uint64]chan response
	done    chan struct{}
	banners map[string]func()
	// toolEvents: chat replies, the end combination and audio packets from the helper.
	toolEvents func(ToolEvent, []byte)
}

func NewHelperClient(rwc io.ReadWriteCloser) *HelperClient {
	c := &HelperClient{rwc: rwc, pending: map[uint64]chan response{}, done: make(chan struct{}), banners: map[string]func(){}}
	go c.readLoop()
	return c
}

// Done is closed when the helper's pipe closed.
func (c *HelperClient) Done() <-chan struct{} { return c.done }

func (c *HelperClient) readLoop() {
	defer func() {
		c.mu.Lock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.mu.Unlock()
		close(c.done)
	}()
	for {
		m, data, err := readMsg(c.rwc)
		if err != nil {
			return
		}
		if m.Event == "tool" {
			c.handleToolEvent(m, data)
			continue
		}
		if m.Event == "banner_end" {
			c.mu.Lock()
			fn := c.banners[m.Sess]
			delete(c.banners, m.Sess)
			c.mu.Unlock()
			if fn != nil {
				go fn()
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[m.ID]
		delete(c.pending, m.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- response{m: m, data: data}
		}
	}
}

func (c *HelperClient) call(ctx context.Context, method string, params any, out any, timeout time.Duration) ([]byte, error) {
	return c.callData(ctx, method, params, nil, out, timeout)
}

// callData sends binary data with the request (a picture for the clipboard).
func (c *HelperClient) callData(ctx context.Context, method string, params any, payload []byte, out any, timeout time.Duration) ([]byte, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	ch := make(chan response, 1)
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return nil, ErrHelperGone
	default:
	}
	c.next++
	id := c.next
	c.pending[id] = ch
	c.mu.Unlock()
	c.wmu.Lock()
	err = writeMsg(c.rwc, wireMsg{ID: id, Method: method, Params: raw}, payload)
	c.wmu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ErrHelperGone
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, ErrHelperGone
		}
		if r.m.Error != "" {
			return nil, errors.New(r.m.Error)
		}
		if out != nil && len(r.m.Result) > 0 {
			if err := json.Unmarshal(r.m.Result, out); err != nil {
				return nil, err
			}
		}
		return r.data, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.C:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("the session helper did not answer %s within %v", method, timeout)
	}
}

const helperTimeout = 15 * time.Second

func (c *HelperClient) Ping() error {
	_, err := c.call(context.Background(), "ping", nil, nil, 5*time.Second)
	return err
}

func (c *HelperClient) Displays() ([]remotedesktop.DisplayInfo, error) {
	var v []remotedesktop.DisplayInfo
	_, err := c.call(context.Background(), "displays", nil, &v, helperTimeout)
	return v, err
}

func (c *HelperClient) CaptureFrame(opts remotedesktop.CaptureOptions) (remotedesktop.Frame, error) {
	var f remotedesktop.Frame
	_, err := c.call(context.Background(), "capture", opts, &f, helperTimeout)
	return f, err
}

func (c *HelperClient) Grab(stream string, req remotedesktop.GrabRequest) (*remotedesktop.EncodedFrame, error) {
	var h remotedesktop.FrameHeader
	data, err := c.call(context.Background(), "grab", streamParams{Stream: stream, Req: req}, &h, helperTimeout)
	if err != nil {
		return nil, err
	}
	if h.T == "" {
		return nil, nil // unchanged
	}
	return &remotedesktop.EncodedFrame{Header: h, Data: data}, nil
}

func (c *HelperClient) ResetStream(stream string) {
	_, _ = c.call(context.Background(), "reset", streamParams{Stream: stream}, nil, helperTimeout)
}

func (c *HelperClient) EndStream(stream string) {
	_, _ = c.call(context.Background(), "end_stream", streamParams{Stream: stream}, nil, helperTimeout)
}

func (c *HelperClient) Input(ev remotedesktop.InputEvent) error {
	_, err := c.call(context.Background(), "input", ev, nil, 5*time.Second)
	return err
}

func (c *HelperClient) Consent(ctx context.Context, req userui.ConsentRequest) (userui.ConsentAnswer, error) {
	req = req.Normalize()
	var a userui.ConsentAnswer
	_, err := c.call(ctx, "consent", req, &a, time.Duration(req.TimeoutSeconds+15)*time.Second)
	return a, err
}

func (c *HelperClient) ShowBanner(info userui.BannerInfo, onEnd func()) error {
	c.mu.Lock()
	c.banners[info.SessionID] = onEnd
	c.mu.Unlock()
	_, err := c.call(context.Background(), "banner_show", bannerParams{Info: info}, nil, helperTimeout)
	if err != nil {
		c.mu.Lock()
		delete(c.banners, info.SessionID)
		c.mu.Unlock()
	}
	return err
}

func (c *HelperClient) HideBanner(sessionID string) {
	c.mu.Lock()
	delete(c.banners, sessionID)
	c.mu.Unlock()
	_, _ = c.call(context.Background(), "banner_hide", bannerParams{Info: userui.BannerInfo{SessionID: sessionID}}, nil, helperTimeout)
}

func (c *HelperClient) ClipboardText() (string, error) {
	var s string
	_, err := c.call(context.Background(), "clip_get", nil, &s, helperTimeout)
	return s, err
}

func (c *HelperClient) SetClipboardText(text string) error {
	_, err := c.call(context.Background(), "clip_set", text, nil, helperTimeout)
	return err
}

func (c *HelperClient) Info() Info {
	var i Info
	if _, err := c.call(context.Background(), "info", nil, &i, 5*time.Second); err != nil {
		return Info{Mode: "session_helper"}
	}
	i.Mode = "session_helper"
	return i
}

func (c *HelperClient) Close() error { return c.rwc.Close() }
