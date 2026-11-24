package clipboard

import (
	"encoding/binary"
	"image"
	"image/color"
	"testing"
)

func TestDIBRoundTrip(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	src.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255})
	src.SetNRGBA(2, 1, color.NRGBA{B: 200, G: 10, A: 128})
	dib := ImageToDIB(src)
	got, err := DIBToImage(dib)
	if err != nil {
		t.Fatal(err)
	}
	if got.Bounds().Dx() != 3 || got.Bounds().Dy() != 2 {
		t.Fatalf("size %v", got.Bounds())
	}
	if c := color.NRGBAModel.Convert(got.At(0, 0)).(color.NRGBA); c.R != 255 || c.A != 255 {
		t.Fatalf("top-left %v", c)
	}
	if c := color.NRGBAModel.Convert(got.At(2, 1)).(color.NRGBA); c.B != 200 || c.G != 10 || c.A != 128 {
		t.Fatalf("bottom-right %v", c)
	}
}

func TestDIB24BitBottomUpWithoutAlpha(t *testing.T) {
	// 2x1, 24-bit: blue pixel then white, row padded to 8 bytes.
	b := make([]byte, 40+8)
	binary.LittleEndian.PutUint32(b[0:], 40)
	binary.LittleEndian.PutUint32(b[4:], 2)
	binary.LittleEndian.PutUint32(b[8:], 1)
	binary.LittleEndian.PutUint16(b[12:], 1)
	binary.LittleEndian.PutUint16(b[14:], 24)
	copy(b[40:], []byte{255, 0, 0, 255, 255, 255})
	img, err := DIBToImage(b)
	if err != nil {
		t.Fatal(err)
	}
	if c := color.NRGBAModel.Convert(img.At(0, 0)).(color.NRGBA); c.B != 255 || c.R != 0 || c.A != 255 {
		t.Fatalf("pixel %v", c)
	}
}

func TestDIBRejectsTruncatedAndCompressed(t *testing.T) {
	if _, err := DIBToImage([]byte{1, 2, 3}); err == nil {
		t.Fatal("short header accepted")
	}
	b := make([]byte, 40)
	binary.LittleEndian.PutUint32(b[0:], 40)
	binary.LittleEndian.PutUint32(b[4:], 10)
	binary.LittleEndian.PutUint32(b[8:], 10)
	binary.LittleEndian.PutUint16(b[14:], 8)
	if _, err := DIBToImage(b); err == nil {
		t.Fatal("8-bit palette accepted")
	}
}

func TestDropFilesLayout(t *testing.T) {
	b := DropFiles([]string{`C:\a.txt`, `D:\é.png`})
	if binary.LittleEndian.Uint32(b[0:]) != 20 || binary.LittleEndian.Uint32(b[16:]) != 1 {
		t.Fatal("DROPFILES header wrong")
	}
	want := len(`C:\a.txt`) + 1 + len([]rune(`D:\é.png`)) + 1 + 1
	if (len(b)-20)/2 != want {
		t.Fatalf("list length %d, want %d units", (len(b)-20)/2, want)
	}
	if b[len(b)-1] != 0 || b[len(b)-2] != 0 || b[len(b)-3] != 0 || b[len(b)-4] != 0 {
		t.Fatal("list not double-NUL terminated")
	}
}

func TestCheckPathsAndImage(t *testing.T) {
	if err := CheckPaths([]string{`C:\Users\x\Downloads\a.txt`}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{nil, {"relative.txt"}, {"C:\a\x00b"}} {
		if CheckPaths(bad) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := CheckImagePNG([]byte("not a png")); err == nil {
		t.Fatal("garbage accepted as PNG")
	}
	img := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	png, err := EncodePNG(img)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CheckImagePNG(png); err != nil {
		t.Fatal(err)
	}
}

func TestParseURIList(t *testing.T) {
	got := ParseURIList("# comment\r\nfile:///home/a/b%20c.txt\r\nhttp://x/y\r\nfile:///tmp/z\n")
	if len(got) != 2 || got[0] != "/home/a/b c.txt" || got[1] != "/tmp/z" {
		t.Fatalf("%q", got)
	}
}
