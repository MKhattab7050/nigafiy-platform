//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
)

// showCode prints the ID and PIN and blocks until Enter (or the end of input).
func showCode(caption, text string) {
	fmt.Printf("%s\n\n%s\n\nPress Enter to end Quick Support.\n", caption, text)
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func showError(caption, text string) { fmt.Fprintf(os.Stderr, "%s: %s\n", caption, text) }

func removeSelf(exe string) { _ = os.Remove(exe) }
