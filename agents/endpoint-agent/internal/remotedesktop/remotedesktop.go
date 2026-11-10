// Package remotedesktop provides live screen capture, multi-monitor enumeration,
// adaptive JPEG encoding, and interactive mouse/keyboard input injection for
// authorized remote support sessions.
package remotedesktop

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"time"
)

type DisplayInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Primary bool   `json:"primary"`
}

type CaptureOptions struct {
	DisplayIndex int     `json:"display_index"`
	Quality      int     `json:"quality"` // 25..95
	Scale        float64 `json:"scale"`   // 0.25..1.0
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
	CaptureMode  string        `json:"capture_mode"` // native | session0_fallback
	JPEGBase64   string        `json:"jpeg_base64"`
	CapturedAt   string        `json:"captured_at"`
}

type InputEvent struct {
	Kind         string  `json:"kind"` // mouse_move | mouse_click | mouse_down | mouse_up | mouse_wheel | key_press | text
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
}

func CaptureFrame(opts CaptureOptions) (Frame, error) {
	start := time.Now()
	if opts.Quality < 25 {
		opts.Quality = 65
	}
	if opts.Quality > 95 {
		opts.Quality = 95
	}
	if opts.Scale < 0.25 || opts.Scale > 1.0 {
		opts.Scale = 0.75
	}

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

	srcW := rawImg.Bounds().Dx()
	srcH := rawImg.Bounds().Dy()
	var finalImg image.Image = rawImg
	outW, outH := srcW, srcH
	if opts.Scale < 0.99 && srcW > 320 && srcH > 200 {
		outW = int(float64(srcW) * opts.Scale)
		outH = int(float64(srcH) * opts.Scale)
		finalImg = resizeNearest(rawImg, outW, outH)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, finalImg, &jpeg.Options{Quality: opts.Quality}); err != nil {
		return Frame{}, err
	}
	encoded := buf.Bytes()

	return Frame{
		DisplayIndex: idx,
		Displays:     displays,
		Width:        outW,
		Height:       outH,
		SourceWidth:  srcW,
		SourceHeight: srcH,
		Quality:      opts.Quality,
		Scale:        opts.Scale,
		CaptureMs:    time.Since(start).Milliseconds(),
		ByteLength:   len(encoded),
		CaptureMode:  mode,
		JPEGBase64:   base64.StdEncoding.EncodeToString(encoded),
		CapturedAt:   time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func resizeNearest(src *image.RGBA, dstW, dstH int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	srcW := src.Bounds().Dx()
	srcH := src.Bounds().Dy()
	for y := 0; y < dstH; y++ {
		sy := (y * srcH) / dstH
		srcRowOffset := sy * src.Stride
		dstRowOffset := y * img.Stride
		for x := 0; x < dstW; x++ {
			sx := (x * srcW) / dstW
			si := srcRowOffset + sx*4
			di := dstRowOffset + x*4
			img.Pix[di+0] = src.Pix[si+0]
			img.Pix[di+1] = src.Pix[si+1]
			img.Pix[di+2] = src.Pix[si+2]
			img.Pix[di+3] = 255
		}
	}
	return img
}

func renderDiagnosticDesktopRGBA(disp DisplayInfo) *image.RGBA {
	w, h := disp.Width, disp.Height
	if w <= 0 || w > 1920 {
		w = 1280
	}
	if h <= 0 || h > 1080 {
		h = 720
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// Dark slate desktop background with subtle grid and top taskbar bar
	for y := 0; y < h; y++ {
		row := y * img.Stride
		isHeader := y < 44
		isGridY := y%48 == 0
		for x := 0; x < w; x++ {
			i := row + x*4
			if isHeader {
				img.Pix[i+0] = 15
				img.Pix[i+1] = 23
				img.Pix[i+2] = 42
				img.Pix[i+3] = 255
			} else if isGridY || x%48 == 0 {
				img.Pix[i+0] = 30
				img.Pix[i+1] = 41
				img.Pix[i+2] = 59
				img.Pix[i+3] = 255
			} else {
				img.Pix[i+0] = 17
				img.Pix[i+1] = 24
				img.Pix[i+2] = 39
				img.Pix[i+3] = 255
			}
		}
	}
	return img
}
