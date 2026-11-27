package par

import "testing"

func TestRowsCoversEveryRowOnce(t *testing.T) {
	for _, n := range []int{0, 1, 63, 64, 500, 1081} {
		seen := make([]int32, n)
		Rows(n, func(lo, hi int) {
			for i := lo; i < hi; i++ {
				seen[i]++
			}
		})
		for i, c := range seen {
			if c != 1 {
				t.Fatalf("n=%d row %d seen %d times", n, i, c)
			}
		}
	}
}
