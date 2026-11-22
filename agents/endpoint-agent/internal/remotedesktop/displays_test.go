package remotedesktop

import "testing"

func TestOrderDisplaysPrimaryFirstAndAllDisplays(t *testing.T) {
	got := OrderDisplays([]DisplayInfo{
		{Name: "DISPLAY3", X: 1920, Y: 0, Width: 1280, Height: 1024},
		{Name: "DISPLAY1", X: 0, Y: 0, Width: 1920, Height: 1080, Primary: true},
		{Name: "", X: -1600, Y: 200, Width: 1600, Height: 900},
	})
	if len(got) != 4 {
		t.Fatalf("want 3 monitors + All, got %+v", got)
	}
	if !got[0].Primary || got[0].Name != "Display 1 (DISPLAY1)" || got[1].X != -1600 || got[1].Name != "Display 2" || got[2].Name != "Display 3 (DISPLAY3)" {
		t.Fatalf("order/names %+v", got)
	}
	all := got[3]
	if !all.All || all.Index != 3 || all.X != -1600 || all.Y != 0 || all.Width != 1600+1920+1280 || all.Height != 1100 {
		t.Fatalf("all displays %+v", all)
	}
	for i, d := range got {
		if d.Index != i {
			t.Fatalf("index %d = %d", i, d.Index)
		}
	}
	if one := OrderDisplays([]DisplayInfo{{Width: 800, Height: 600, Primary: true}}); len(one) != 1 || one[0].All {
		t.Fatalf("one monitor needs no All entry: %+v", one)
	}
}
