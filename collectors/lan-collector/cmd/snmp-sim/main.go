// snmp-sim plays a small managed switch over SNMP v2c so Port Detective can be tried without
// hardware. Development tool: it is not part of the collector and serves invented data.
//
//	snmp-sim -listen 127.0.0.1:16161 -community demo -devices "00:11:22:33:44:55@1,66:77:88:99:aa:bb@2@20"
//
// Port control can be tried too: with -write-community the switch accepts SETs, and only on the
// OIDs port control uses (ifAdminStatus, ifAlias, and the 802.1Q PVID / VLAN member lists — or
// Cisco vmVlan with -cisco). -vlans defines the VLANs; a device's VLAN puts its port in that VLAN.
//
//	snmp-sim -write-community demo-write -vlans "1:default,20:Staff,99:Quarantine" -devices "00:11:22:33:44:55@1@20"
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
	writeCommunity := flag.String("write-community", "", "write community (empty: read-only switch)")
	name := flag.String("name", "SIMULATED-switch", "sysName")
	ports := flag.Int("ports", 8, "number of ports")
	uplink := flag.String("uplink", "SIMULATED-core", "LLDP neighbour on the last port (empty for none)")
	devices := flag.String("devices", "", "comma-separated mac@port[@vlan]")
	vlanList := flag.String("vlans", "", "comma-separated id:name VLANs (enables the 802.1Q or Cisco VLAN tables)")
	cisco := flag.Bool("cisco", false, "look like a Cisco IOS switch (VTP / vmVlan instead of Q-BRIDGE)")
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
	a.WriteCommunity = *writeCommunity

	if *vlanList != "" {
		var vlans []sim.VLAN
		index := map[int]int{}
		for _, v := range strings.Split(*vlanList, ",") {
			id, label, _ := strings.Cut(strings.TrimSpace(v), ":")
			n, err := strconv.Atoi(id)
			if err != nil || n < 1 || n > 4094 {
				fmt.Fprintln(os.Stderr, "bad VLAN:", v)
				os.Exit(2)
			}
			index[n] = len(vlans)
			vlans = append(vlans, sim.VLAN{ID: n, Name: label})
		}
		placed := map[int]bool{}
		for _, d := range list {
			if i, ok := index[d.VLAN]; ok && !placed[d.Port] {
				vlans[i].Ports = append(vlans[i].Ports, d.Port)
				placed[d.Port] = true
			}
		}
		var trunk []int
		if *uplink != "" {
			trunk = []int{*ports}
		}
		if i, ok := index[1]; ok {
			for p := 1; p <= *ports; p++ {
				if !placed[p] && (len(trunk) == 0 || p != trunk[0]) {
					vlans[i].Ports = append(vlans[i].Ports, p)
				}
			}
		}
		if *cisco {
			a.Cisco(*ports, vlans, trunk...)
		} else {
			a.QBridge(*ports, vlans, trunk...)
		}
	}
	addr, err := a.Start(*listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot listen:", err)
		os.Exit(1)
	}
	mode := "read-only"
	if *writeCommunity != "" {
		mode = "accepts port-control writes"
	}
	fmt.Printf("simulated switch %q listening on %s (%d ports, %d devices, %s)\n", *name, addr, *ports, len(list), mode)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	a.Stop()
}
