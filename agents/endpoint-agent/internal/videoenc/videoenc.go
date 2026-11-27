// Package videoenc turns screen pictures into H.264 for the WebRTC video path (Fleet Pro).
//
// Windows: the encoder is Windows Media Foundation's H.264 encoder MFT, called through COM with
// golang.org/x/sys/windows and syscall (pure Go, no cgo). A hardware encoder MFT is tried first and
// Microsoft's software encoder next. Windows N editions without the Media Feature Pack have neither:
// Open then fails with ErrUnavailable and the session keeps the JPEG path.
//
// Linux and macOS: no encoder (Open returns ErrUnavailable). There is no pure-Go H.264 encoder and
// the platform encoders (VA-API, VideoToolbox) are C APIs that need cgo, which this build does not
// have; those agents keep the JPEG path.
package videoenc

import (
	"errors"
	"image"
	"sync"

	"github.com/nigafiy/agent/internal/par"
)

// ErrUnavailable: this computer has no H.264 encoder the agent can use.
var ErrUnavailable = errors.New("no H.264 encoder is available on this computer")

// Config of one encoder. Width and Height are even (NV12 needs it).
type Config struct {
	Width   int
	Height  int
	FPS     int
	Bitrate int // bits per second
	// Software skips the hardware encoders (used after a hardware encoder failed mid-stream).
	Software bool
}

// Unit is one H.264 access unit in Annex B form (start codes), with whether it is a key frame.
type Unit struct {
	Data []byte
	Key  bool
}

// Encoder encodes NV12 pictures of the configured size.
type Encoder interface {
	// Encode takes one picture (NV12, Width x Height) and returns the access units that are ready:
	// usually one, none while a hardware encoder is still filling its pipeline. key asks for a key
	// frame.
	Encode(nv12 []byte, frame int64, key bool) ([]Unit, error)
	// SetBitrate changes the target bitrate during the stream.
	SetBitrate(bps int) error
	// Name says which encoder this is (shown to the operator and audited).
	Name() string
	Close()
}

// Opener opens an encoder (the platform's by default; tests use a fake one).
type Opener func(Config) (Encoder, error)

// Capability is what the agent reports in its hello.
type Capability struct {
	Supported bool   `json:"supported"`
	Encoder   string `json:"encoder,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

var (
	probeOnce sync.Once
	probed    Capability
)

// Probe opens and closes a small encoder once and remembers whether that worked.
func Probe() Capability {
	probeOnce.Do(func() { probed = ProbeWith(Open) })
	return probed
}

// ProbeWith is Probe with another opener (tests).
func ProbeWith(open Opener) Capability {
	enc, err := open(Config{Width: 640, Height: 360, FPS: 30, Bitrate: 1_000_000})
	if err != nil {
		return Capability{Reason: err.Error()}
	}
	name := enc.Name()
	enc.Close()
	return Capability{Supported: true, Encoder: name}
}

// EvenSize rounds a picture size down to even numbers (at least 2 x 2).
func EvenSize(w, h int) (int, int) {
	return max(2, w&^1), max(2, h&^1)
}

// ToNV12 converts an RGBA picture of exactly w x h (both even) to NV12: a full-resolution luma
// plane followed by interleaved Cb/Cr at half resolution, BT.601 limited range (what the H.264
// encoders and the browsers' decoders assume for video without colour information).
func ToNV12(img *image.RGBA, w, h int, dst []byte) []byte {
	need := w*h + w*h/2
	if cap(dst) < need {
		dst = make([]byte, need)
	}
	dst = dst[:need]
	b := img.Bounds()
	if b.Dx() < w || b.Dy() < h {
		clear(dst[:w*h])
		for i := w * h; i < need; i++ {
			dst[i] = 128
		}
		return dst
	}
	ys := dst[:w*h]
	uv := dst[w*h:]
	par.Rows(h/2, func(lo, hi int) {
		toNV12Rows(img, w, ys, uv, lo*2, hi*2)
	})
	return dst
}

// toNV12Rows converts source rows [from, to) (both even) into the Y and interleaved UV planes.
func toNV12Rows(img *image.RGBA, w int, ys, uv []byte, from, to int) {
	for y := from; y < to; y += 2 {
		r0 := img.Pix[y*img.Stride:]
		r1 := img.Pix[(y+1)*img.Stride:]
		y0 := ys[y*w:]
		y1 := ys[(y+1)*w:]
		c := uv[(y/2)*w:]
		for x := 0; x < w; x += 2 {
			var sr, sg, sb int32
			for i, p := range [4][]byte{r0[x*4:], r0[x*4+4:], r1[x*4:], r1[x*4+4:]} {
				r, g, bb := int32(p[0]), int32(p[1]), int32(p[2])
				l := byte((66*r + 129*g + 25*bb + 128 + 4096) >> 8)
				switch i {
				case 0:
					y0[x] = l
				case 1:
					y0[x+1] = l
				case 2:
					y1[x] = l
				default:
					y1[x+1] = l
				}
				sr += r
				sg += g
				sb += bb
			}
			sr, sg, sb = sr/4, sg/4, sb/4
			c[x] = clamp8((-38*sr - 74*sg + 112*sb + 128 + 32768) >> 8)
			c[x+1] = clamp8((112*sr - 94*sg - 18*sb + 128 + 32768) >> 8)
		}
	}
}

func clamp8(v int32) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

// NALTypes lists the NAL unit types of an Annex B access unit.
func NALTypes(au []byte) []byte {
	var out []byte
	for _, n := range SplitNALs(au) {
		if len(n) > 0 {
			out = append(out, n[0]&0x1f)
		}
	}
	return out
}

// SplitNALs splits Annex B bytes on 3- or 4-byte start codes (the NAL units without them).
func SplitNALs(b []byte) [][]byte {
	var out [][]byte
	start := -1
	i := 0
	for i+2 < len(b) {
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 {
			if start >= 0 {
				end := i
				if end > start && b[end-1] == 0 {
					end--
				}
				out = append(out, b[start:end])
			}
			i += 3
			start = i
			continue
		}
		i++
	}
	if start >= 0 && start < len(b) {
		out = append(out, b[start:])
	}
	return out
}

// IsKey reports whether an access unit holds an IDR slice (NAL type 5).
func IsKey(au []byte) bool {
	for _, t := range NALTypes(au) {
		if t == 5 {
			return true
		}
	}
	return false
}

// WithParameterSets puts the SPS and PPS (Annex B, from the encoder's sequence header) in front of
// a key frame that does not carry them, so a browser joining at that key frame can decode it.
func WithParameterSets(au, seqHeader []byte) []byte {
	if len(seqHeader) == 0 || !IsKey(au) {
		return au
	}
	for _, t := range NALTypes(au) {
		if t == 7 {
			return au
		}
	}
	out := make([]byte, 0, len(seqHeader)+len(au))
	return append(append(out, seqHeader...), au...)
}
