// Package par splits per-row picture work (screen capture colour swap, downscaling, colour
// conversion) across the machine's cores. One core did all of it and the computer's screen
// reached a phone at 9–15 pictures a second (owner, 2026-11-27).
package par

import (
	"runtime"
	"sync"
)

// minRows keeps tiny pictures (tests, thumbnails) on one goroutine: starting more costs more.
const minRows = 64

// Rows calls fn over [0, n) in contiguous chunks, at most one per core, and waits for all of them.
// fn must only touch its own rows.
func Rows(n int, fn func(lo, hi int)) {
	parts := min(runtime.GOMAXPROCS(0), n/minRows)
	if parts <= 1 {
		fn(0, n)
		return
	}
	var wg sync.WaitGroup
	step := (n + parts - 1) / parts
	for lo := 0; lo < n; lo += step {
		hi := min(lo+step, n)
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn(lo, hi)
		}()
	}
	wg.Wait()
}
