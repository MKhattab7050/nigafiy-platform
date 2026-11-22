package remotedesktop

import (
	"fmt"
	"sort"
)

// OrderDisplays numbers monitors (primary first, then left to right, top to bottom) and, with
// more than one, adds a last "All displays" entry covering the bounding box of every monitor (the
// virtual screen). Names keep the system's device name when there is one.
func OrderDisplays(mons []DisplayInfo) []DisplayInfo {
	out := append([]DisplayInfo(nil), mons...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Primary != out[j].Primary {
			return out[i].Primary
		}
		if out[i].X != out[j].X {
			return out[i].X < out[j].X
		}
		return out[i].Y < out[j].Y
	})
	for i := range out {
		out[i].Index = i
		out[i].All = false
		if out[i].Name == "" {
			out[i].Name = fmt.Sprintf("Display %d", i+1)
		} else {
			out[i].Name = fmt.Sprintf("Display %d (%s)", i+1, out[i].Name)
		}
	}
	if len(out) > 1 {
		minX, minY := out[0].X, out[0].Y
		maxX, maxY := out[0].X+out[0].Width, out[0].Y+out[0].Height
		for _, d := range out[1:] {
			minX, minY = min(minX, d.X), min(minY, d.Y)
			maxX, maxY = max(maxX, d.X+d.Width), max(maxY, d.Y+d.Height)
		}
		out = append(out, DisplayInfo{Index: len(out), Name: fmt.Sprintf("All displays (%d)", len(out)), X: minX, Y: minY, Width: maxX - minX, Height: maxY - minY, All: true})
	}
	return out
}
