// snmp-sim plays a small managed switch over SNMP v2c so Port Detective can be tried without
// hardware. Development tool: it is not part of the collector and serves invented data.
//
//	snmp-sim -listen 127.0.0.1:16161 -community demo -devices "00:11:22:33:44:55@1,66:77:88:99:aa:bb@2@20"
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"

	"github.com/lan-detective/lan-collector/internal/snmp/sim"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:16161", "address to listen on")
	community := flag.String("community", "demo", "read community")
	name := flag.String("name", "SIMULATED-switch", "sysName")
	ports := flag.Int("ports", 8, "number of ports")
	uplink := flag.String("uplink", "SIMULATED-core", "LLDP neighbour on the last port (empty for none)")
	devices := flag.String("devices", "", "comma-separated mac@port[@vlan]")
	flag.Parse()

	var list []sim.Device
	for _, d := range strings.Split(*devices, ",") {
		parts := strings.Split(strings.TrimSpace(d), "@")
		if len(parts) < 2 {
			continue
		}
		port, _ := strconv.Atoi(parts[1])
		vlan := 0
		if len(parts) > 2 {
			vlan, _ = strconv.Atoi(parts[2])
		}
		list = append(list, sim.Device{MAC: parts[0], Port: port, VLAN: vlan})
	}
	a := sim.Switch(*community, *name, *ports, list, *uplink)
	addr, err := a.Start(*listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot listen:", err)
		os.Exit(1)
	}
	fmt.Printf("simulated switch %q listening on %s (%d ports, %d devices)\n", *name, addr, *ports, len(list))
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	a.Stop()
}
