package remotedesktop

import "image"

// Colour depth of the live picture (Fleet Pro): 24-bit (full colour), 16-bit (5-6-5: the low bits
// are dropped before JPEG, so gradients band slightly and the picture compresses a little better)
// and 8-bit grey (one channel: the smallest frames). The toolbar shows the measured kbit/s of each.
const (
	Depth24 = 24
	Depth16 = 16
	Depth8  = 8
)

// NormalizeDepth maps any other value to 24.
func NormalizeDepth(d int) int {
	if d == Depth16 || d == Depth8 {
		return d
	}
	return Depth24
}

// reduceDepth changes img in place: 16 keeps 5-6-5 bits; 8 turns it grey (ITU-R BT.601 luma).
func reduceDepth(img *image.RGBA, depth int) {
	switch depth {
	case Depth16:
		for i := 0; i < len(img.Pix); i += 4 {
			img.Pix[i] &= 0xF8
			img.Pix[i+1] &= 0xFC
			img.Pix[i+2] &= 0xF8
		}
	case Depth8:
		for i := 0; i < len(img.Pix); i += 4 {
			y := uint8((299*uint32(img.Pix[i]) + 587*uint32(img.Pix[i+1]) + 114*uint32(img.Pix[i+2]) + 500) / 1000)
			img.Pix[i], img.Pix[i+1], img.Pix[i+2] = y, y, y
		}
	}
}

// toGray: the 8-bit picture as a one-channel image (JPEG then stores one component).
func toGray(img *image.RGBA, r image.Rectangle) *image.Gray {
	g := image.NewGray(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		src := img.Pix[(r.Min.Y+y)*img.Stride+r.Min.X*4:]
		dst := g.Pix[y*g.Stride:]
		for x := 0; x < r.Dx(); x++ {
			dst[x] = src[x*4]
		}
	}
	return g
}

// BlendCursor draws a cursor picture (straight alpha) at (x, y) of img.
func BlendCursor(img *image.RGBA, cur *image.NRGBA, x, y int) {
	b := img.Bounds()
	cb := cur.Bounds()
	for cy := 0; cy < cb.Dy(); cy++ {
		py := y + cy
		if py < b.Min.Y || py >= b.Max.Y {
			continue
		}
		for cx := 0; cx < cb.Dx(); cx++ {
			px := x + cx
			if px < b.Min.X || px >= b.Max.X {
				continue
			}
			s := cur.Pix[cy*cur.Stride+cx*4:]
			a := uint32(s[3])
			if a == 0 {
				continue
			}
			d := img.Pix[(py-b.Min.Y)*img.Stride+(px-b.Min.X)*4:]
			for c := 0; c < 3; c++ {
				d[c] = uint8((uint32(s[c])*a + uint32(d[c])*(255-a) + 127) / 255)
			}
		}
	}
}
