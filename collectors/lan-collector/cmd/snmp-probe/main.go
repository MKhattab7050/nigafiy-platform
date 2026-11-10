// snmp-probe reads one switch the way the collector does and prints a summary. Use it to check
// that SNMP is enabled and the credentials work before adding the switch in LAN Detective.
// The community is read from the SNMP_COMMUNITY environment variable so it stays out of shell history.
//
//	SNMP_COMMUNITY=... snmp-probe -host 192.168.1.2
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/lan-detective/lan-collector/internal/snmp"
)

func main() {
	host := flag.String("host", "", "IP address of the switch")
	port := flag.Int("port", 161, "SNMP port")
	flag.Parse()
	community := os.Getenv("SNMP_COMMUNITY")
	if *host == "" || community == "" {
		fmt.Fprintln(os.Stderr, "usage: SNMP_COMMUNITY=<community> snmp-probe -host <ip> [-port 161]")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, err := snmp.Poll(ctx, snmp.Target{Host: *host, Port: *port, Version: "2c", Community: community}, 3*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read failed:", err)
		os.Exit(1)
	}
	fmt.Printf("name: %s\ndescription: %s\nports: %d  addresses: %d  LLDP neighbours: %d\n", res.SysName, res.SysDescr, len(res.Ports), len(res.FDB), len(res.LLDP))
	perPort := map[int]int{}
	for _, e := range res.FDB {
		perPort[e.IfIndex]++
	}
	for _, p := range res.Ports {
		state := "down"
		if p.OperUp {
			state = "up"
		}
		fmt.Printf("  %-22s %-4s %6d Mb/s  %d address(es)\n", p.Name, state, p.SpeedMbps, perPort[p.IfIndex])
	}
	if len(res.Truncated) > 0 {
		fmt.Println("partial (size ceiling reached):", res.Truncated)
	}
}
