package clipboard

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"path/filepath"
	"strings"
)

// Images and file lists on the clipboard (Fleet Pro: clipboard both ways for images and files).
// Images travel as PNG, capped at MaxImageBytes; a file list travels as paths only: the files
// themselves move through the file manager's chunked, SHA-256-checked transfer. Nothing is logged.

// MaxImageBytes bounds a PNG either direction (the API enforces the same limit).
const MaxImageBytes = 4 << 20

// MaxImagePixels bounds the decoded picture (a 4 MB PNG can expand to a huge bitmap).
const MaxImagePixels = 40_000_000

// MaxFiles bounds a file list either direction.
const MaxFiles = 50

var (
	ErrNoImage     = errors.New("the clipboard holds no picture")
	ErrNoFiles     = errors.New("the clipboard holds no copied files")
	ErrImageTooBig = errors.New("the clipboard picture is larger than 4 MB as PNG")
	// ErrRichUnsupported: macOS has no command-line tool for pictures or files on the pasteboard
	// (pbcopy/pbpaste carry text only), and cgo is not available for AppKit.
	ErrRichUnsupported = errors.New("pictures and copied files on the clipboard are not supported on this platform (Windows, and Linux with xclip or wl-clipboard)")
)

// ReadImagePNG returns the clipboard's picture as PNG.
func ReadImagePNG() ([]byte, error) {
	b, err := readImagePNG()
	if err != nil {
		return nil, err
	}
	if len(b) > MaxImageBytes {
		return nil, ErrImageTooBig
	}
	return b, nil
}

// EncodePNG is the PNG form of a picture read from the clipboard.
func EncodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// WriteImagePNG puts a PNG picture on the clipboard.
func WriteImagePNG(data []byte) error {
	img, err := CheckImagePNG(data)
	if err != nil {
		return err
	}
	return writeImagePNG(img, data)
}

// CheckImagePNG validates a PNG before it reaches the clipboard (size, format, pixel count).
func CheckImagePNG(data []byte) (image.Image, error) {
	if len(data) == 0 {
		return nil, errors.New("empty picture")
	}
	if len(data) > MaxImageBytes {
		return nil, ErrImageTooBig
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("not a PNG picture: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > MaxImagePixels {
		return nil, errors.New("the picture is too large")
	}
	return png.Decode(bytes.NewReader(data))
}

// ReadFiles returns the paths of the files copied on this computer (Explorer's Copy).
func ReadFiles() ([]string, error) { return readFiles() }

// WriteFiles puts a file list on the clipboard, so the person can paste the files (they were
// uploaded through the file manager first). Paths must be absolute, without NUL.
func WriteFiles(paths []string) error {
	if err := CheckPaths(paths); err != nil {
		return err
	}
	return writeFiles(paths)
}

// CheckPaths validates a file list.
func CheckPaths(paths []string) error {
	if len(paths) == 0 {
		return errors.New("no files")
	}
	if len(paths) > MaxFiles {
		return fmt.Errorf("at most %d files", MaxFiles)
	}
	for _, p := range paths {
		if p == "" || len(p) > 1024 || strings.ContainsRune(p, 0) || !isAbs(p) {
			return fmt.Errorf("not an absolute path: %q", p)
		}
	}
	return nil
}

func isAbs(p string) bool {
	if filepath.IsAbs(p) {
		return true
	}
	// A Windows path checked on another OS (tests) or a UNC path.
	return (len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) || strings.HasPrefix(p, `\\`)
}

// ── DIB (device-independent bitmap) conversion: pure Go, shared by the Windows code and tests ──

// DIBToImage decodes a CF_DIB / CF_DIBV5 block: BITMAPINFOHEADER (or V4/V5) + optional masks +
// pixels. 24- and 32-bit uncompressed and BI_BITFIELDS (32-bit) pictures are supported.
func DIBToImage(b []byte) (image.Image, error) {
	if len(b) < 40 {
		return nil, errors.New("clipboard bitmap header too short")
	}
	le := binary.LittleEndian
	hdrSize := int(le.Uint32(b[0:]))
	w := int(int32(le.Uint32(b[4:])))
	h := int(int32(le.Uint32(b[8:])))
	bpp := int(le.Uint16(b[14:]))
	comp := le.Uint32(b[16:])
	if hdrSize < 40 || hdrSize > len(b) || w <= 0 || h == 0 {
		return nil, errors.New("clipboard bitmap header not understood")
	}
	topDown := h < 0
	if topDown {
		h = -h
	}
	if w*h > MaxImagePixels {
		return nil, errors.New("the clipboard picture is too large")
	}
	const biRGB, biBitfields = 0, 3
	off := hdrSize
	rMask, gMask, bMask, aMask := uint32(0x00ff0000), uint32(0x0000ff00), uint32(0x000000ff), uint32(0)
	switch {
	case comp == biBitfields && bpp == 32:
		if hdrSize >= 56 { // V4/V5 carry the masks (and alpha) inside the header
			rMask, gMask, bMask, aMask = le.Uint32(b[40:]), le.Uint32(b[44:]), le.Uint32(b[48:]), le.Uint32(b[52:])
		} else {
			if len(b) < off+12 {
				return nil, errors.New("clipboard bitmap masks missing")
			}
			rMask, gMask, bMask = le.Uint32(b[off:]), le.Uint32(b[off+4:]), le.Uint32(b[off+8:])
			off += 12
		}
	case comp == biRGB && (bpp == 32 || bpp == 24):
	default:
		return nil, fmt.Errorf("clipboard bitmap format not supported (%d bit, compression %d)", bpp, comp)
	}
	stride := ((w*bpp + 31) / 32) * 4
	if len(b) < off+stride*h {
		return nil, errors.New("clipboard bitmap data truncated")
	}
	pix := b[off:]
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	// 32-bit BI_RGB: the fourth byte is alpha only when some pixel uses it (many programs leave 0).
	useAlpha := aMask != 0
	if bpp == 32 && comp == biRGB {
		for y := 0; y < h && !useAlpha; y++ {
			row := pix[y*stride:]
			for x := 0; x < w; x++ {
				if row[x*4+3] != 0 {
					useAlpha = true
					break
				}
			}
		}
		aMask = 0xff000000
	}
	for y := 0; y < h; y++ {
		srcY := h - 1 - y
		if topDown {
			srcY = y
		}
		row := pix[srcY*stride:]
		for x := 0; x < w; x++ {
			var c color.NRGBA
			if bpp == 24 {
				c = color.NRGBA{R: row[x*3+2], G: row[x*3+1], B: row[x*3], A: 255}
			} else {
				v := le.Uint32(row[x*4:])
				c = color.NRGBA{R: maskByte(v, rMask), G: maskByte(v, gMask), B: maskByte(v, bMask), A: 255}
				if useAlpha {
					c.A = maskByte(v, aMask)
				}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	return img, nil
}

func maskByte(v, mask uint32) uint8 {
	if mask == 0 {
		return 0
	}
	shift := 0
	for mask&1 == 0 {
		mask >>= 1
		shift++
	}
	val := (v >> shift) & mask
	if mask == 0xff {
		return uint8(val)
	}
	return uint8(val * 255 / mask)
}

// ImageToDIB encodes a picture as a CF_DIB block: BITMAPINFOHEADER, 32-bit BI_RGB, bottom-up.
func ImageToDIB(img image.Image) []byte {
	bnd := img.Bounds()
	w, h := bnd.Dx(), bnd.Dy()
	out := make([]byte, 40+w*h*4)
	le := binary.LittleEndian
	le.PutUint32(out[0:], 40)
	le.PutUint32(out[4:], uint32(int32(w)))
	le.PutUint32(out[8:], uint32(int32(h)))
	le.PutUint16(out[12:], 1)
	le.PutUint16(out[14:], 32)
	le.PutUint32(out[20:], uint32(w*h*4))
	for y := 0; y < h; y++ {
		row := out[40+(h-1-y)*w*4:]
		for x := 0; x < w; x++ {
			c := color.NRGBAModel.Convert(img.At(bnd.Min.X+x, bnd.Min.Y+y)).(color.NRGBA)
			row[x*4], row[x*4+1], row[x*4+2], row[x*4+3] = c.B, c.G, c.R, c.A
		}
	}
	return out
}

// DropFiles builds a CF_HDROP block: DROPFILES (20 bytes, wide names) + NUL-separated UTF-16
// paths ending with an extra NUL.
func DropFiles(paths []string) []byte {
	var u []uint16
	for _, p := range paths {
		for _, r := range p {
			if r > 0xffff {
				r -= 0x10000
				u = append(u, uint16(0xd800+(r>>10)), uint16(0xdc00+(r&0x3ff)))
				continue
			}
			u = append(u, uint16(r))
		}
		u = append(u, 0)
	}
	u = append(u, 0)
	out := make([]byte, 20+len(u)*2)
	le := binary.LittleEndian
	le.PutUint32(out[0:], 20) // pFiles: offset of the list
	le.PutUint32(out[16:], 1) // fWide
	for i, v := range u {
		le.PutUint16(out[20+i*2:], v)
	}
	return out
}

// ParseURIList turns a text/uri-list into local paths (file:// only).
func ParseURIList(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || u.Scheme != "file" || u.Path == "" {
			continue
		}
		out = append(out, u.Path)
		if len(out) >= MaxFiles {
			break
		}
	}
	return out
}
