package remotedesktop

import (
	"errors"
	"hash/maphash"
	"image"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/videoenc"
)

// Video path (WebRTC, Fleet Pro): the same capture as the JPEG stream, scaled, converted to NV12
// and encoded as H.264 by videoenc. The privacy screen stays out of this picture exactly as it
// stays out of the JPEG one (it is excluded from capture itself).

// MaxVideoEdge caps the longest side of the video picture.
const MaxVideoEdge = 1920

// VideoIdleInterval: an unchanged screen is encoded again at least this often (the viewer's
// decoder and the RTCP reports keep going).
const VideoIdleInterval = time.Second

// VideoRequest asks for the next video picture of one display.
type VideoRequest struct {
	Display int     `json:"display"`
	Scale   float64 `json:"scale"`
	MaxEdge int     `json:"max_edge,omitempty"`
	FPS     int     `json:"fps"`
	Bitrate int     `json:"bitrate"`
	Key     bool    `json:"key,omitempty"`
	Cursor  bool    `json:"cursor,omitempty"`
}

// VideoHeader describes one encoded picture.
type VideoHeader struct {
	Display  int           `json:"display"`
	W        int           `json:"w"`
	H        int           `json:"h"`
	SW       int           `json:"sw"`
	SH       int           `json:"sh"`
	Key      bool          `json:"key"`
	Encoder  string        `json:"encoder"`
	CapMs    int64         `json:"cap_ms"`
	EncMs    int64         `json:"enc_ms"`
	Displays []DisplayInfo `json:"displays,omitempty"`
	// Units: byte length of each access unit in the frame's data, in order.
	Units []int `json:"units"`
	// Fallback: why the hardware encoder was replaced by the software one (once).
	Fallback string `json:"fallback,omitempty"`
}

// VideoFrame is one grab's output: zero or more access units.
type VideoFrame struct {
	Header VideoHeader
	Units  []videoenc.Unit
}

// Data joins the units (their lengths are in Header.Units).
func (f *VideoFrame) Data() []byte {
	var out []byte
	for _, u := range f.Units {
		out = append(out, u.Data...)
	}
	return out
}

// SplitVideoData is the inverse of Data (the helper pipe carries one blob).
func SplitVideoData(h VideoHeader, data []byte) ([]videoenc.Unit, error) {
	var out []videoenc.Unit
	off := 0
	for _, n := range h.Units {
		if n < 0 || off+n > len(data) {
			return nil, errors.New("video frame lengths do not match its data")
		}
		u := data[off : off+n]
		out = append(out, videoenc.Unit{Data: u, Key: videoenc.IsKey(u)})
		off += n
	}
	if off != len(data) {
		return nil, errors.New("video frame lengths do not match its data")
	}
	return out, nil
}

// VideoGrabber keeps one stream's encoder.
type VideoGrabber struct {
	source   CaptureSource
	open     videoenc.Opener
	mu       sync.Mutex
	enc      videoenc.Encoder
	cfg      videoenc.Config
	display  int
	frame    int64
	seed     maphash.Seed
	lastHash uint64
	lastAt   time.Time
	software bool
	nv12     []byte
	fellBack string

	// Prefetch: grab the next screen while this one is scaled and encoded (see EnablePrefetch).
	prefetch bool
	pmu      sync.Mutex
	next     chan shot
}

// shot is one screen capture.
type shot struct {
	img      *image.RGBA
	displays []DisplayInfo
	idx      int
	err      error
	display  int
	at       time.Time
	ms       int64
}

// prefetchMaxAge: an older prefetched screen (the stream paused, nobody watching) is thrown away
// and the screen read again, so a viewer never sees an old picture.
const prefetchMaxAge = 120 * time.Millisecond

// EnablePrefetch makes each grab start reading the next screen right away, in the background.
// Reading the screen (GDI) takes about as long as scaling and encoding it, so doing both at once
// about doubles the pictures a second without making any picture older (owner, 2026-11-27:
// "from the computer to the phone is slow"). Only for the real screen: a test's synthetic one
// expects each grab to read it when called.
func (g *VideoGrabber) EnablePrefetch() { g.prefetch = true }

func (g *VideoGrabber) readScreen(display int) shot {
	start := time.Now()
	img, displays, idx, _, err := g.source(display)
	return shot{img: img, displays: displays, idx: idx, err: err, display: display, at: start, ms: time.Since(start).Milliseconds()}
}

// take returns the screen for this grab: the prefetched one when it is fresh and for this display,
// otherwise a new read; with prefetch on it starts reading the next one before returning.
func (g *VideoGrabber) take(display int) shot {
	if !g.prefetch {
		return g.readScreen(display)
	}
	g.pmu.Lock()
	ch := g.next
	g.next = nil
	g.pmu.Unlock()
	var s shot
	ok := false
	if ch != nil {
		s = <-ch
		ok = s.err == nil && s.display == display && time.Since(s.at) < prefetchMaxAge
	}
	if !ok {
		s = g.readScreen(display)
	}
	if s.err == nil {
		next := make(chan shot, 1)
		g.pmu.Lock()
		g.next = next
		g.pmu.Unlock()
		go func() { next <- g.readScreen(display) }()
	}
	return s
}

// NewVideoGrabber: src nil = this screen, open nil = the platform's encoder.
func NewVideoGrabber(src CaptureSource, open videoenc.Opener) *VideoGrabber {
	if src == nil {
		src = SystemCapture
	}
	if open == nil {
		open = videoenc.Open
	}
	return &VideoGrabber{source: src, open: open, seed: maphash.MakeSeed(), display: -1}
}

// VideoSize is the encoded size for a source picture: the scale, then the longest-edge cap, even.
func VideoSize(sw, sh int, scale float64, maxEdge int) (int, int) {
	if scale <= 0 || scale > 1 {
		scale = 1
	}
	if maxEdge <= 0 {
		maxEdge = MaxVideoEdge
	}
	w, h := float64(sw)*scale, float64(sh)*scale
	if long := max(w, h); long > float64(maxEdge) {
		w, h = w*float64(maxEdge)/long, h*float64(maxEdge)/long
	}
	return videoenc.EvenSize(int(w), int(h))
}

// Grab captures and encodes one picture; nil when the screen is unchanged (and was sent less than
// VideoIdleInterval ago).
func (g *VideoGrabber) Grab(req VideoRequest) (*VideoFrame, error) {
	s := g.take(req.Display)
	if s.err != nil {
		return nil, s.err
	}
	img, displays, idx, capMs := s.img, s.displays, s.idx, s.ms
	if req.Cursor && idx >= 0 && idx < len(displays) {
		drawCursor(img, displays[idx])
	}
	sw, sh := img.Bounds().Dx(), img.Bounds().Dy()
	w, h := VideoSize(sw, sh, req.Scale, req.MaxEdge)
	if w != sw || h != sh {
		img = resizeArea(img, w, h)
	}
	fps := req.FPS
	if fps <= 0 {
		fps = 30
	}
	bitrate := req.Bitrate
	if bitrate <= 0 {
		bitrate = 4_000_000
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	encStart := time.Now()
	hash := pictureHash(g.seed, img)
	key := req.Key
	if g.enc == nil || g.cfg.Width != w || g.cfg.Height != h || g.cfg.FPS != fps || g.display != idx {
		if err := g.reopen(videoenc.Config{Width: w, Height: h, FPS: fps, Bitrate: bitrate, Software: g.software}); err != nil {
			return nil, err
		}
		g.display = idx
		key = true
	} else if !key && hash == g.lastHash && time.Since(g.lastAt) < VideoIdleInterval {
		return nil, nil
	}
	if bitrate != g.cfg.Bitrate {
		if err := g.enc.SetBitrate(bitrate); err != nil {
			// No live bitrate control on this encoder: a new one at the new rate (a key frame).
			if err := g.reopen(videoenc.Config{Width: w, Height: h, FPS: fps, Bitrate: bitrate, Software: g.software}); err != nil {
				return nil, err
			}
			key = true
		}
		g.cfg.Bitrate = bitrate
	}
	g.nv12 = videoenc.ToNV12(img, w, h, g.nv12)
	units, err := g.enc.Encode(g.nv12, g.frame, key)
	if err != nil && !g.software {
		// A hardware encoder that fails mid-stream: the software encoder takes over.
		g.fellBack = err.Error()
		g.software = true
		if rerr := g.reopen(videoenc.Config{Width: w, Height: h, FPS: fps, Bitrate: bitrate, Software: true}); rerr != nil {
			return nil, err
		}
		units, err = g.enc.Encode(g.nv12, g.frame, true)
	}
	if err != nil {
		return nil, err
	}
	g.frame++
	g.lastHash, g.lastAt = hash, time.Now()
	hdr := VideoHeader{Display: idx, W: w, H: h, SW: sw, SH: sh, Encoder: g.enc.Name(), CapMs: capMs, EncMs: time.Since(encStart).Milliseconds(), Displays: displays, Fallback: g.fellBack}
	g.fellBack = ""
	for _, u := range units {
		hdr.Units = append(hdr.Units, len(u.Data))
		hdr.Key = hdr.Key || u.Key
	}
	return &VideoFrame{Header: hdr, Units: units}, nil
}

func (g *VideoGrabber) reopen(cfg videoenc.Config) error {
	if g.enc != nil {
		g.enc.Close()
		g.enc = nil
	}
	enc, err := g.open(cfg)
	if err != nil {
		return err
	}
	g.enc, g.cfg = enc, cfg
	return nil
}

// Close releases the encoder.
func (g *VideoGrabber) Close() {
	g.pmu.Lock()
	g.next = nil // a read in flight finishes into its own buffered channel and is dropped
	g.pmu.Unlock()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.enc != nil {
		g.enc.Close()
		g.enc = nil
	}
}

func pictureHash(seed maphash.Seed, img *image.RGBA) uint64 {
	var h maphash.Hash
	h.SetSeed(seed)
	_, _ = h.Write(img.Pix)
	return h.Sum64()
}
