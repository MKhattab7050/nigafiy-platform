// identify-probe prints what devices in a scope say about themselves (debug tool).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"

	"github.com/nigafiy/sensor/internal/identify"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: identify-probe <cidr> [ip ...]")
		return
	}
	prefix := netip.MustParsePrefix(os.Args[1])
	out := identify.Run(context.Background(), prefix, os.Args[2:])
	b, _ := json.MarshalIndent(out, "", " ")
	fmt.Println(string(b))
}
