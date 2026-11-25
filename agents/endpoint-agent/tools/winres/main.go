// winres writes a .syso resource object holding one application manifest (see internal/winres).
//
//	go run ./tools/winres -manifest cmd/nigafiy-support/nigafiy-support.manifest -o cmd/nigafiy-support/rsrc_windows_amd64.syso
//
// The .syso is committed; rerun this after changing the manifest (cmd/nigafiy-support has a
// go:generate line, and a test there fails if the committed object is out of date).
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/nigafiy/agent/internal/winres"
)

func main() {
	in := flag.String("manifest", "", "the application manifest (XML)")
	out := flag.String("o", "", "the .syso file to write")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: winres -manifest <file.manifest> -o <file.syso>")
		os.Exit(2)
	}
	m, err := os.ReadFile(*in)
	if err == nil {
		var obj []byte
		if obj, err = winres.ManifestObject(m); err == nil {
			err = os.WriteFile(*out, obj, 0o644)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "winres:", err)
		os.Exit(1)
	}
}
