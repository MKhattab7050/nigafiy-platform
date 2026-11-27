package desktop

import (
	"context"
	"encoding/json"

	"github.com/nigafiy/agent/internal/remotedesktop"
	"github.com/nigafiy/agent/internal/videoenc"
)

// Video is the WebRTC picture source: H.264 from the same capture as the JPEG stream. Local,
// HelperClient and Supervisor implement it; the encoder runs where the capture runs (inside the
// user's session for the service), and only encoded access units cross the helper pipe.
type Video interface {
	VideoCapability() videoenc.Capability
	GrabVideo(stream string, req remotedesktop.VideoRequest) (*remotedesktop.VideoFrame, error)
	EndVideo(stream string)
}

// SetVideoOpener replaces the H.264 encoder (tests: a fake encoder). Before any video grab.
func (l *Local) SetVideoOpener(open videoenc.Opener) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.videoOpen = open
}

func (l *Local) VideoCapability() videoenc.Capability {
	l.mu.Lock()
	open := l.videoOpen
	l.mu.Unlock()
	if open != nil {
		return videoenc.ProbeWith(open)
	}
	return videoenc.Probe()
}

func (l *Local) GrabVideo(stream string, req remotedesktop.VideoRequest) (*remotedesktop.VideoFrame, error) {
	l.mu.Lock()
	if l.video == nil {
		l.video = map[string]*remotedesktop.VideoGrabber{}
	}
	g := l.video[stream]
	if g == nil {
		if len(l.video) >= 4 { // ended explicitly; this only bounds a leak
			for k, old := range l.video {
				old.Close()
				delete(l.video, k)
			}
		}
		g = remotedesktop.NewVideoGrabber(l.capture, l.videoOpen)
		if l.realScreen {
			g.EnablePrefetch()
		}
		l.video[stream] = g
	}
	l.mu.Unlock()
	return g.Grab(req)
}

func (l *Local) EndVideo(stream string) {
	l.mu.Lock()
	g := l.video[stream]
	delete(l.video, stream)
	l.mu.Unlock()
	if g != nil {
		g.Close()
	}
}

// ── Session helper pipe ──

func (c *HelperClient) VideoCapability() videoenc.Capability {
	var v videoenc.Capability
	if _, err := c.call(context.Background(), "video_cap", nil, &v, helperTimeout); err != nil {
		return videoenc.Capability{Reason: err.Error()}
	}
	return v
}

type videoParams struct {
	Stream string                     `json:"stream"`
	Req    remotedesktop.VideoRequest `json:"req"`
}

func (c *HelperClient) GrabVideo(stream string, req remotedesktop.VideoRequest) (*remotedesktop.VideoFrame, error) {
	var h remotedesktop.VideoHeader
	data, err := c.call(context.Background(), "grab_video", videoParams{Stream: stream, Req: req}, &h, helperTimeout)
	if err != nil {
		return nil, err
	}
	if h.Encoder == "" {
		return nil, nil // unchanged
	}
	units, err := remotedesktop.SplitVideoData(h, data)
	if err != nil {
		return nil, err
	}
	return &remotedesktop.VideoFrame{Header: h, Units: units}, nil
}

func (c *HelperClient) EndVideo(stream string) {
	_, _ = c.call(context.Background(), "end_video", videoParams{Stream: stream}, nil, helperTimeout)
}

// serveVideo answers the video methods on the helper side; false when m is not one of them.
func serveVideo(d Desktop, method string, params []byte, reply func(v any, data []byte, err error)) bool {
	v, ok := d.(Video)
	switch method {
	case "video_cap":
		if !ok {
			reply(videoenc.Capability{Reason: "this desktop has no video encoder"}, nil, nil)
			return true
		}
		reply(v.VideoCapability(), nil, nil)
	case "grab_video", "end_video":
		var p videoParams
		_ = json.Unmarshal(params, &p)
		if !ok {
			reply(nil, nil, videoenc.ErrUnavailable)
			return true
		}
		if method == "end_video" {
			v.EndVideo(p.Stream)
			reply(nil, nil, nil)
			return true
		}
		f, err := v.GrabVideo(p.Stream, p.Req)
		if err != nil || f == nil {
			reply(nil, nil, err)
			return true
		}
		reply(f.Header, f.Data(), nil)
	default:
		return false
	}
	return true
}

// ── Supervisor (the service: forwards to the current helper) ──

func (s *Supervisor) VideoCapability() videoenc.Capability {
	c, err := s.get()
	if err != nil {
		return videoenc.Capability{Reason: err.Error()}
	}
	return c.VideoCapability()
}

func (s *Supervisor) GrabVideo(stream string, req remotedesktop.VideoRequest) (*remotedesktop.VideoFrame, error) {
	c, err := s.get()
	if err != nil {
		return nil, err
	}
	return c.GrabVideo(stream, req)
}

func (s *Supervisor) EndVideo(stream string) {
	if c, err := s.get(); err == nil {
		c.EndVideo(stream)
	}
}
