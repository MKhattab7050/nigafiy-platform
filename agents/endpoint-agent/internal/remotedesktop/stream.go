package remotedesktop

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/maphash"
	"image"
	"image/jpeg"
	"sync"
	"time"
)

// Streaming encoder for the live (WebSocket) channel. Unlike CaptureFrame (one JPEG per HTTP
// command), it remembers the previous picture tile by tile and sends only what changed:
//   - an unchanged screen sends nothing at all;
//   - when a few tiles changed, only those regions are JPEG-encoded (runs of adjacent changed tiles
//     in one tile row are merged into one rectangle);
//   - when most of the screen changed, or the size/quality/display changed, one full frame is sent.
// Pure-Go JPEG only: no pure-Go WebP encoder exists in the standard library or the module cache
// (golang.org/x/image/webp decodes only), so WebP is not offered.

// TileSize is the edge of a diff tile in output pixels (a multiple of the 8x8/16x16 JPEG blocks,
// so tile borders fall on block borders).
const TileSize = 64

// FullFrameRatio: above this share of changed tiles one full frame is cheaper than many tiles.
const FullFrameRatio = 0.5

// PacketMagic starts every binary frame packet: 'N', version 1.
var PacketMagic = [2]byte{'N', 1}

// MaxPacketHeader bounds the JSON header of a packet.
const MaxPacketHeader = 64 << 10

type GrabRequest struct {
	Display int     `json:"display"`
	Quality int     `json:"quality"`
	Scale   float64 `json:"scale"`
	// Full asks for a full frame even if nothing changed (a viewer joined or lost a frame).
	Full bool `json:"full,omitempty"`
}

// Tile is one JPEG-encoded rectangle of a frame, in output pixels; N is its byte length.
type Tile struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
	N int `json:"n"`
}

// FrameHeader describes one binary packet. The viewer draws each tile at (x, y) of a W x H canvas.
type FrameHeader struct {
	T          string        `json:"t"` // always "frame"
	Seq        uint64        `json:"seq"`
	Full       bool          `json:"full"`
	Display    int           `json:"display"`
	Displays   []DisplayInfo `json:"displays,omitempty"`
	W          int           `json:"w"`
	H          int           `json:"h"`
	SW         int           `json:"sw"`
	SH         int           `json:"sh"`
	Q          int           `json:"q"`
	S          float64       `json:"s"`
	Fmt        string        `json:"fmt"`
	Tiles      []Tile        `json:"tiles"`
	CapMs      int64         `json:"cap_ms"`
	EncMs      int64         `json:"enc_ms"`
	ChangedPct float64       `json:"changed_pct"`
	Mode       string        `json:"mode"`
	At         string        `json:"at"`
}

type EncodedFrame struct {
	Header FrameHeader
	Data   []byte
}

// Packet: magic (2) | header length uint32 BE (4) | JSON header | tile bytes in header order.
func (f *EncodedFrame) Packet() []byte {
	hdr, _ := json.Marshal(f.Header)
	out := make([]byte, 0, 6+len(hdr)+len(f.Data))
	out = append(out, PacketMagic[:]...)
	out = binary.BigEndian.AppendUint32(out, uint32(len(hdr)))
	out = append(out, hdr...)
	return append(out, f.Data...)
}

// ParsePacket splits a packet and checks that the tiles account for every byte.
func ParsePacket(b []byte) (FrameHeader, []byte, error) {
	var h FrameHeader
	if len(b) < 6 || b[0] != PacketMagic[0] || b[1] != PacketMagic[1] {
		return h, nil, errors.New("not a frame packet")
	}
	n := int(binary.BigEndian.Uint32(b[2:6]))
	if n <= 0 || n > MaxPacketHeader || 6+n > len(b) {
		return h, nil, errors.New("bad frame packet header length")
	}
	if err := json.Unmarshal(b[6:6+n], &h); err != nil {
		return h, nil, err
	}
	data := b[6+n:]
	total := 0
	for _, t := range h.Tiles {
		total += t.N
	}
	if total != len(data) {
		return h, nil, errors.New("frame packet tile sizes do not match its data")
	}
	return h, data, nil
}

// CaptureSource reads one display (tests replace it with synthetic pictures).
type CaptureSource func(display int) (img *image.RGBA, displays []DisplayInfo, idx int, mode string, err error)

// SystemCapture captures from this computer's screen.
func SystemCapture(display int) (*image.RGBA, []DisplayInfo, int, string, error) {
	displays, err := EnumerateDisplays()
	if err != nil || len(displays) == 0 {
		return nil, nil, 0, "", errors.New("no display available for screen capture")
	}
	idx := display
	if idx < 0 || idx >= len(displays) {
		idx = 0
	}
	img, mode, err := captureDisplayRGBA(displays[idx])
	return img, displays, idx, mode, err
}

// Encoder keeps one stream's previous picture (per-tile hashes).
type Encoder struct {
	mu       sync.Mutex
	source   CaptureSource
	seed     maphash.Seed
	key      string
	hashes   []uint64
	cols     int
	rows     int
	lastSent time.Time
	seq      uint64
	displays string
}

func NewEncoder(src CaptureSource) *Encoder {
	if src == nil {
		src = SystemCapture
	}
	return &Encoder{source: src, seed: maphash.MakeSeed()}
}

// Reset forgets the previous picture: the next Grab sends a full frame.
func (e *Encoder) Reset() {
	e.mu.Lock()
	e.key = ""
	e.hashes = nil
	e.mu.Unlock()
}

// Grab captures and encodes the changes since the previous frame. It returns (nil, nil) when the
// screen did not change (and the last frame was sent less than MaxUnchangedInterval ago).
func (e *Encoder) Grab(req GrabRequest) (*EncodedFrame, error) {
	start := time.Now()
	img, displays, idx, mode, err := e.source(req.Display)
	if err != nil {
		return nil, err
	}
	capMs := time.Since(start).Milliseconds()
	return e.encode(img, req, displays, idx, mode, capMs, time.Now())
}

func (e *Encoder) encode(raw *image.RGBA, req GrabRequest, displays []DisplayInfo, idx int, mode string, capMs int64, now time.Time) (*EncodedFrame, error) {
	opts := normalizeOptions(CaptureOptions{Quality: req.Quality, Scale: req.Scale})
	encStart := time.Now()
	srcW, srcH := raw.Bounds().Dx(), raw.Bounds().Dy()
	img := raw
	outW, outH := srcW, srcH
	if opts.Scale < 0.99 && srcW > 320 && srcH > 200 {
		outW = int(float64(srcW) * opts.Scale)
		outH = int(float64(srcH) * opts.Scale)
		img = resizeArea(raw, outW, outH)
	}
	cols := (outW + TileSize - 1) / TileSize
	rows := (outH + TileSize - 1) / TileSize
	hashes := make([]uint64, cols*rows)
	for ty := 0; ty < rows; ty++ {
		for tx := 0; tx < cols; tx++ {
			hashes[ty*cols+tx] = tileHash(e.seed, img, tx, ty)
		}
	}
	displaysJSON, _ := json.Marshal(displays)

	e.mu.Lock()
	defer e.mu.Unlock()
	key := keyOf(idx, outW, outH, opts.Quality)
	full := req.Full || e.key != key || len(e.hashes) != len(hashes) || now.Sub(e.lastSent) >= MaxUnchangedInterval
	var changed []int
	if !full {
		for i, h := range hashes {
			if e.hashes[i] != h {
				changed = append(changed, i)
			}
		}
		if len(changed) == 0 {
			return nil, nil
		}
		if float64(len(changed)) > FullFrameRatio*float64(len(hashes)) {
			full = true
		}
	}

	hdr := FrameHeader{T: "frame", Display: idx, W: outW, H: outH, SW: srcW, SH: srcH, Q: opts.Quality, S: opts.Scale, Fmt: "jpeg", CapMs: capMs, Mode: mode}
	var buf bytes.Buffer
	encodeRect := func(r image.Rectangle) error {
		before := buf.Len()
		if err := jpeg.Encode(&buf, img.SubImage(r), &jpeg.Options{Quality: opts.Quality}); err != nil {
			return err
		}
		hdr.Tiles = append(hdr.Tiles, Tile{X: r.Min.X, Y: r.Min.Y, W: r.Dx(), H: r.Dy(), N: buf.Len() - before})
		return nil
	}
	if full {
		if err := encodeRect(image.Rect(0, 0, outW, outH)); err != nil {
			return nil, err
		}
		hdr.ChangedPct = 100
	} else {
		for _, r := range mergeTiles(changed, cols, outW, outH) {
			if err := encodeRect(r); err != nil {
				return nil, err
			}
		}
		hdr.ChangedPct = float64(int(float64(len(changed))/float64(len(hashes))*1000)) / 10
	}
	hdr.Full = full
	if full || string(displaysJSON) != e.displays {
		hdr.Displays = displays
	}
	e.seq++
	hdr.Seq = e.seq
	hdr.EncMs = time.Since(encStart).Milliseconds()
	hdr.At = now.UTC().Format(time.RFC3339Nano)
	e.key, e.hashes, e.cols, e.rows, e.lastSent, e.displays = key, hashes, cols, rows, now, string(displaysJSON)
	return &EncodedFrame{Header: hdr, Data: buf.Bytes()}, nil
}

func keyOf(idx, w, h, q int) string {
	b, _ := json.Marshal([4]int{idx, w, h, q})
	return string(b)
}

func tileHash(seed maphash.Seed, img *image.RGBA, tx, ty int) uint64 {
	var h maphash.Hash
	h.SetSeed(seed)
	b := img.Bounds()
	x0, y0 := tx*TileSize, ty*TileSize
	x1, y1 := min(x0+TileSize, b.Dx()), min(y0+TileSize, b.Dy())
	for y := y0; y < y1; y++ {
		row := img.Pix[y*img.Stride+x0*4 : y*img.Stride+x1*4]
		_, _ = h.Write(row)
	}
	return h.Sum64()
}

// mergeTiles turns changed tile indexes (sorted) into rectangles: consecutive changed tiles of one
// tile row become one rectangle, clipped to the picture.
func mergeTiles(changed []int, cols, w, h int) []image.Rectangle {
	var out []image.Rectangle
	for i := 0; i < len(changed); {
		start := changed[i]
		j := i
		for j+1 < len(changed) && changed[j+1] == changed[j]+1 && changed[j+1]/cols == start/cols {
			j++
		}
		ty, tx0, tx1 := start/cols, start%cols, changed[j]%cols
		out = append(out, image.Rect(tx0*TileSize, ty*TileSize, min((tx1+1)*TileSize, w), min((ty+1)*TileSize, h)))
		i = j + 1
	}
	return out
}
