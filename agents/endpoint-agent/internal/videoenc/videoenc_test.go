package videoenc

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"testing"
)

func TestToNV12Colours(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for x := 0; x < 4; x++ {
		for y := 0; y < 2; y++ {
			c := color.RGBA{255, 255, 255, 255} // white on the left
			if x >= 2 {
				c = color.RGBA{0, 0, 0, 255} // black on the right
			}
			img.SetRGBA(x, y, c)
		}
	}
	out := ToNV12(img, 4, 2, nil)
	if len(out) != 4*2+4 {
		t.Fatalf("len %d", len(out))
	}
	// BT.601 limited range: white Y=235, black Y=16, grey chroma 128.
	if out[0] != 235 || out[1] != 235 || out[2] != 16 || out[3] != 16 || out[4] != 235 || out[7] != 16 {
		t.Fatalf("luma %v", out[:8])
	}
	for _, c := range out[8:] {
		if c < 127 || c > 129 {
			t.Fatalf("chroma %v", out[8:])
		}
	}
	// Pure red: Cr high, Cb low.
	red := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for i := 0; i < len(red.Pix); i += 4 {
		red.Pix[i], red.Pix[i+3] = 255, 255
	}
	o := ToNV12(red, 2, 2, nil)
	if o[0] != 82 || o[4] > 100 || o[5] < 230 {
		t.Fatalf("red %v", o)
	}
}

func TestToNV12SmallPictureIsBlank(t *testing.T) {
	out := ToNV12(image.NewRGBA(image.Rect(0, 0, 2, 2)), 4, 4, nil)
	if out[0] != 0 || out[16] != 128 {
		t.Fatalf("%v", out)
	}
}

func TestEvenSize(t *testing.T) {
	if w, h := EvenSize(1365, 767); w != 1364 || h != 766 {
		t.Fatal(w, h)
	}
	if w, h := EvenSize(1, 0); w != 2 || h != 2 {
		t.Fatal(w, h)
	}
}

func TestNALsAndParameterSets(t *testing.T) {
	sps := []byte{0, 0, 0, 1, 0x67, 1, 2}
	pps := []byte{0, 0, 0, 1, 0x68, 3}
	idr := []byte{0, 0, 1, 0x65, 9, 9, 9}
	p := []byte{0, 0, 0, 1, 0x41, 7}
	if got := NALTypes(append(append([]byte{}, sps...), idr...)); !bytes.Equal(got, []byte{7, 5}) {
		t.Fatalf("types %v", got)
	}
	if !IsKey(idr) || IsKey(p) {
		t.Fatal("key detection")
	}
	hdr := append(append([]byte{}, sps...), pps...)
	withPS := WithParameterSets(idr, hdr)
	if !bytes.Equal(NALTypes(withPS), []byte{7, 8, 5}) {
		t.Fatalf("%v", NALTypes(withPS))
	}
	// Not twice, and never on a P frame.
	if got := WithParameterSets(withPS, hdr); !bytes.Equal(got, withPS) {
		t.Fatal("added twice")
	}
	if got := WithParameterSets(p, hdr); !bytes.Equal(got, p) {
		t.Fatal("added to a P frame")
	}
	nals := SplitNALs(withPS)
	if len(nals) != 3 || nals[0][0] != 0x67 || len(nals[0]) != 3 {
		t.Fatalf("%x", nals)
	}
}

func TestProbeWithReportsTheReason(t *testing.T) {
	c := ProbeWith(func(Config) (Encoder, error) { return nil, errors.New("no MFT here") })
	if c.Supported || c.Reason != "no MFT here" {
		t.Fatalf("%+v", c)
	}
	c = ProbeWith(func(Config) (Encoder, error) { return &nopEncoder{}, nil })
	if !c.Supported || c.Encoder != "nop" {
		t.Fatalf("%+v", c)
	}
}

type nopEncoder struct{ closed bool }

func (n *nopEncoder) Encode([]byte, int64, bool) ([]Unit, error) { return nil, nil }
func (n *nopEncoder) SetBitrate(int) error                       { return nil }
func (n *nopEncoder) Name() string                               { return "nop" }
func (n *nopEncoder) Close()                                     { n.closed = true }
