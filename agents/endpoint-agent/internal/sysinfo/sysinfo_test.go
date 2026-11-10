package sysinfo

import "testing"

func TestParseTasklistCSV(t *testing.T) {
	sample := `"System Idle Process","0","Services","0","8 K"` + "\n" +
		`"svchost.exe","1240","Services","0","45,120 K"` + "\n" +
		`"chrome.exe","8812","Console","1","312,400 K"` + "\n"
	got := ParseTasklistCSV(sample)
	if len(got) != 2 {
		t.Fatalf("expected 2 processes, got %d: %+v", len(got), got)
	}
	if got[0].Name != "chrome.exe" || got[0].PID != 8812 || got[0].MemMB < 300 {
		t.Fatalf("unexpected first process: %+v", got[0])
	}
}

func TestParseNetstat(t *testing.T) {
	sample := `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    192.168.1.25:51422     93.184.216.34:443      ESTABLISHED     8812
  UDP    0.0.0.0:5353           *:*                                    1240
`
	procs := map[int]string{4: "System", 8812: "chrome.exe", 1240: "svchost.exe"}
	got := ParseNetstat(sample, procs)
	if len(got) != 3 {
		t.Fatalf("expected 3 connections, got %d: %+v", len(got), got)
	}
	if got[1].LocalPort != 51422 || got[1].RemoteAddress != "93.184.216.34" || got[1].RemotePort != 443 || got[1].ProcessName != "chrome.exe" {
		t.Fatalf("unexpected TCP connection: %+v", got[1])
	}
}

