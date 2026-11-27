// Package remotedesktop provides live screen capture, multi-monitor enumeration,
// adaptive JPEG encoding, and interactive mouse/keyboard input injection for
// authorized remote support sessions.
package remotedesktop

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"hash/maphash"
	"image"
	"image/jpeg"
	"math"
	"sync"
	"time"

	"github.com/nigafiy/agent/internal/par"
)

type DisplayInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Primary bool   `json:"primary"`
	// All: the whole virtual screen (every monitor), listed last when there is more than one.
	All bool `json:"all,omitempty"`
}

type CaptureOptions struct {
	DisplayIndex int     `json:"display_index"`
	Quality      int     `json:"quality"` // 25..95
	Scale        float64 `json:"scale"`   // 0.25..1.0
	// FullFrame asks for the image even when the screen has not changed since the last frame (the
	// viewer has no frame yet, e.g. after a page reload).
	FullFrame bool `json:"full_frame,omitempty"`
}

type Frame struct {
	DisplayIndex int           `json:"display_index"`
	Displays     []DisplayInfo `json:"displays"`
	Width        int           `json:"width"`
	Height       int           `json:"height"`
	SourceWidth  int           `json:"source_width"`
	SourceHeight int           `json:"source_height"`
	Quality      int           `json:"quality"`
	Scale        float64       `json:"scale"`
	CaptureMs    int64         `json:"capture_ms"`
	ByteLength   int           `json:"byte_length"`
	CaptureMode  string        `json:"capture_mode"` // native | native_gdi | native_dxgi
	// Unchanged: the screen is pixel-for-pixel what the previous frame showed (same display, size
	// and quality), so no image is sent and the viewer keeps showing the previous one.
	Unchanged  bool   `json:"unchanged,omitempty"`
	JPEGBase64 string `json:"jpeg_base64,omitempty"`
	CapturedAt string `json:"captured_at"`
}

type InputEvent struct {
	// mouse_move | mouse_click | mouse_down | mouse_up | mouse_wheel | key_press | text |
	// key_down | key_up (a physical key by position: Code) | key_combo (Keys pressed in order,
	// released in reverse: Win, Alt+Tab, Ctrl+Esc… that the operator's browser cannot capture)
	Kind         string  `json:"kind"`
	DisplayIndex int     `json:"display_index"`
	NormalizedX  float64 `json:"x"`      // 0.0 .. 1.0 relative to selected display
	NormalizedY  float64 `json:"y"`      // 0.0 .. 1.0 relative to selected display
	Button       string  `json:"button"` // left | right | middle
	Double       bool    `json:"double,omitempty"`
	DeltaY       int     `json:"delta_y,omitempty"`
	Key          string  `json:"key,omitempty"`
	Text         string  `json:"text,omitempty"`
	Ctrl         bool    `json:"ctrl,omitempty"`
	Alt          bool    `json:"alt,omitempty"`
	Shift        bool    `json:"shift,omitempty"`
	Meta         bool    `json:"meta,omitempty"`
	// Code is KeyboardEvent.code (the physical key) for key_down / key_up.
	Code string `json:"code,omitempty"`
	// Keys of a key_combo (names such as "Ctrl", "Alt", "Tab", "Win", "R").
	Keys []string `json:"keys,omitempty"`
}

// MaxUnchangedInterval: even an unchanged screen is sent again at least this often, so a viewer
// that lost a frame recovers on its own.
const MaxUnchangedInterval = 10 * time.Second

// frameState remembers what the last frame showed, to skip sending an identical one.
type frameState struct {
	mu       sync.Mutex
	seed     maphash.Seed
	hash     uint64
	key      string
	lastFull time.Time
	valid    bool
}

func newFrameState() *frameState { return &frameState{seed: maphash.MakeSeed()} }

var sessionFrames = newFrameState()

func normalizeOptions(opts CaptureOptions) CaptureOptions {
	if opts.Quality < 25 {
		opts.Quality = 65
	}
	if opts.Quality > 95 {
		opts.Quality = 95
	}
	if opts.Scale < 0.25 || opts.Scale > 1.0 {
		opts.Scale = 0.75
	}
	return opts
}

func CaptureFrame(opts CaptureOptions) (Frame, error) {
	start := time.Now()
	opts = normalizeOptions(opts)

	displays, err := EnumerateDisplays()
	if err != nil || len(displays) == 0 {
		return Frame{}, errors.New("no display available for screen capture")
	}
	idx := opts.DisplayIndex
	if idx < 0 || idx >= len(displays) {
		idx = 0
	}
	target := displays[idx]

	rawImg, mode, err := captureDisplayRGBA(target)
	if err != nil {
		return Frame{}, err
	}
	return encodeFrame(sessionFrames, rawImg, opts, displays, idx, mode, start, time.Now())
}

// encodeFrame downscales, skips an unchanged screen, and JPEG-encodes. Separate from the capture so
// it can be tested with synthetic images.
func encodeFrame(state *frameState, rawImg *image.RGBA, opts CaptureOptions, displays []DisplayInfo, idx int, mode string, start, now time.Time) (Frame, error) {
	srcW := rawImg.Bounds().Dx()
	srcH := rawImg.Bounds().Dy()
	finalImg := rawImg
	outW, outH := srcW, srcH
	if opts.Scale < 0.99 && srcW > 320 && srcH > 200 {
		outW = int(float64(srcW) * opts.Scale)
		outH = int(float64(srcH) * opts.Scale)
		finalImg = resizeArea(rawImg, outW, outH)
	}

	frame := Frame{
		DisplayIndex: idx,
		Displays:     displays,
		Width:        outW,
		Height:       outH,
		SourceWidth:  srcW,
		SourceHeight: srcH,
		Quality:      opts.Quality,
		Scale:        opts.Scale,
		CaptureMode:  mode,
	}

	key := fmt.Sprintf("%d/%dx%d/q%d", idx, outW, outH, opts.Quality)
	state.mu.Lock()
	h := maphash.Bytes(state.seed, finalImg.Pix)
	skip := !opts.FullFrame && state.valid && state.key == key && state.hash == h && now.Sub(state.lastFull) < MaxUnchangedInterval
	if !skip {
		state.valid, state.key, state.hash, state.lastFull = true, key, h, now
	}
	state.mu.Unlock()

	if skip {
		frame.Unchanged = true
	} else {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, finalImg, &jpeg.Options{Quality: opts.Quality}); err != nil {
			state.mu.Lock()
			state.valid = false // nothing was sent: the next frame must be a full one
			state.mu.Unlock()
			return Frame{}, err
		}
		frame.ByteLength = buf.Len()
		frame.JPEGBase64 = base64.StdEncoding.EncodeToString(buf.Bytes())
	}
	frame.CaptureMs = time.Since(start).Milliseconds()
	frame.CapturedAt = now.UTC().Format(time.RFC3339Nano)
	return frame, nil
}

// span is one source pixel's share of a destination pixel along one axis (weight in 1/65536).
type span struct {
	index  int
	weight uint32
}

// areaWeights: for each destination index, the source pixels it covers and how much of each
// (box / area filter). The weights of one destination pixel sum to exactly 65536.
func areaWeights(srcN, dstN int) [][]span {
	out := make([][]span, dstN)
	ratio := float64(srcN) / float64(dstN)
	for d := 0; d < dstN; d++ {
		lo := float64(d) * ratio
		hi := math.Min(lo+ratio, float64(srcN))
		var spans []span
		var total int64
		for s := int(lo); s < srcN && float64(s) < hi; s++ {
			cover := math.Min(hi, float64(s+1)) - math.Max(lo, float64(s))
			if cover <= 1e-9 {
				continue
			}
			w := uint32(cover/ratio*65536 + 0.5)
			spans = append(spans, span{s, w})
			total += int64(w)
		}
		if len(spans) == 0 {
			spans = []span{{min(int(lo), srcN-1), 65536}}
			total = 65536
		}
		// Rounding: give the remainder to the largest share so the weights sum to exactly 65536.
		if total != 65536 {
			best := 0
			for i := range spans {
				if spans[i].weight > spans[best].weight {
					best = i
				}
			}
			spans[best].weight = uint32(int64(spans[best].weight) + 65536 - total)
		}
		out[d] = spans
	}
	return out
}

// resizeArea downscales by area averaging: every destination pixel is the average of the source
// pixels it covers (fractional coverage at the edges). Unlike nearest-neighbour sampling it keeps
// thin lines and small text legible instead of dropping or aliasing them. Separable: rows first,
// then columns. (Upscaling is never asked for: the scale is at most 1.)
func resizeArea(src *image.RGBA, dstW, dstH int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	srcW := src.Bounds().Dx()
	srcH := src.Bounds().Dy()
	if dstW <= 0 || dstH <= 0 || srcW <= 0 || srcH <= 0 {
		return dst
	}
	xw := areaWeights(srcW, dstW)
	yw := areaWeights(srcH, dstH)

	// Horizontal pass: srcH rows of dstW pixels, 3 channels, each scaled by 65536 (< 2^24).
	tmp := resizeTmp.get(dstW * srcH * 3)
	defer resizeTmp.put(tmp)
	par.Rows(srcH, func(lo, hi int) {
		for y := lo; y < hi; y++ {
			row := src.Pix[y*src.Stride:]
			out := tmp[y*dstW*3:]
			for x, spans := range xw {
				var r, g, b uint32
				for _, sp := range spans {
					i := sp.index * 4
					r += uint32(row[i]) * sp.weight
					g += uint32(row[i+1]) * sp.weight
					b += uint32(row[i+2]) * sp.weight
				}
				out[x*3], out[x*3+1], out[x*3+2] = r, g, b
			}
		}
	})
	// Vertical pass: sums of value (< 2^24) × weight (≤ 2^16), scaled by 2^32 in total.
	const half = 1 << 31
	par.Rows(dstH, func(lo, hi int) {
		for y := lo; y < hi; y++ {
			spans := yw[y]
			drow := dst.Pix[y*dst.Stride:]
			for x := 0; x < dstW; x++ {
				var r, g, b uint64
				for _, sp := range spans {
					i := (sp.index*dstW + x) * 3
					r += uint64(tmp[i]) * uint64(sp.weight)
					g += uint64(tmp[i+1]) * uint64(sp.weight)
					b += uint64(tmp[i+2]) * uint64(sp.weight)
				}
				di := x * 4
				drow[di] = uint8(min((r+half)>>32, 255))
				drow[di+1] = uint8(min((g+half)>>32, 255))
				drow[di+2] = uint8(min((b+half)>>32, 255))
				drow[di+3] = 255
			}
		}
	})
	return dst
}

// resizeTmp keeps the horizontal pass's buffer (about 18 MB for 1080p) between pictures, so a
// stream of 30 a second does not hand the garbage collector half a gigabyte a second.
var resizeTmp tmpPool

type tmpPool struct{ p sync.Pool }

func (t *tmpPool) get(n int) []uint32 {
	if b, ok := t.p.Get().(*[]uint32); ok && cap(*b) >= n {
		return (*b)[:n]
	}
	return make([]uint32, n)
}

func (t *tmpPool) put(b []uint32) { t.p.Put(&b) }

// errNoDesktop: there is no interactive desktop this process can read (for example a Windows
// service in session 0, or no display server on Linux).
var errNoDesktop = errors.New("the screen could not be captured: the agent has no access to an interactive desktop session")
