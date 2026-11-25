package snmp

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Single-step writes (ifAdminStatus, ifAlias, Cisco vmVlan) are rolled back automatically when the
// read-back does not match what was written.

func TestAliasMismatchIsRolledBack(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	// Set a known description first.
	if _, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "alias", Alias: "NAS"}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	// A switch that truncates descriptions to 4 characters.
	a.SetMangle(func(oid string, v any) any {
		if b, ok := v.([]byte); ok && strings.HasPrefix(oid, oidIfAlias+".") && len(b) > 4 {
			return b[:4]
		}
		return v
	})
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "alias", Alias: "Storage server"}, 2*time.Second)
	if ErrKind(err) != "readback_mismatch" || res == nil || res.Verified || !res.RolledBack {
		t.Fatalf("want a rolled-back mismatch: %v %+v", err, res)
	}
	if v, _ := a.Value(oidIfAlias + ".101"); string(v.([]byte)) != "NAS" {
		t.Fatalf("description not restored: %q", v)
	}
	if res.After.Alias == nil || *res.After.Alias != "NAS" || !strings.Contains(err.Error(), "written back") {
		t.Fatalf("result must report the restored state: %+v %v", res, err)
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), "rollback verified") {
		t.Fatalf("steps: %v", res.Steps)
	}
}

func TestAdminStatusMismatchIsRolledBack(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	// A switch that refuses to shut ports down but answers success, then stores "testing" (3).
	a.SetMangle(func(oid string, v any) any {
		if strings.HasPrefix(oid, oidIfAdminStatus+".") && v == 2 {
			return 3
		}
		return v
	})
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 103, Op: "admin_status", AdminUp: false}, 2*time.Second)
	if ErrKind(err) != "readback_mismatch" || res == nil || !res.RolledBack {
		t.Fatalf("want a rolled-back mismatch: %v %+v", err, res)
	}
	if v, _ := a.Value(oidIfAdminStatus + ".103"); v != 1 {
		t.Fatalf("port not restored to up: %v", v)
	}
	if res.After.AdminUp == nil || !*res.After.AdminUp {
		t.Fatalf("after must be the restored state: %+v", res.After)
	}
}

func TestCiscoVLANMismatchIsRolledBack(t *testing.T) {
	a := ciscoSwitch()
	tg := start(t, a)
	// The switch puts the port into VLAN 1 instead of the requested one.
	a.SetMangle(func(oid string, v any) any {
		if strings.HasPrefix(oid, oidVmVlan+".") && v == 666 {
			return 1
		}
		return v
	})
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 101, Op: "access_vlan", VLAN: 666, Method: "cisco"}, 2*time.Second)
	if ErrKind(err) != "readback_mismatch" || res == nil || !res.RolledBack {
		t.Fatalf("want a rolled-back mismatch: %v %+v", err, res)
	}
	if v, _ := a.Value(oidVmVlan + ".101"); v != 20 {
		t.Fatalf("vmVlan not restored: %v", v)
	}
}

func TestRollbackThatDoesNotStickIsReported(t *testing.T) {
	a := qSwitch()
	tg := start(t, a)
	// Every description write ends up as "????": the rollback cannot restore the old value either.
	a.SetMangle(func(oid string, v any) any {
		if strings.HasPrefix(oid, oidIfAlias+".") {
			return []byte("????")
		}
		return v
	})
	res, err := ApplyPortChange(context.Background(), tg, write, PortChange{IfIndex: 102, Op: "alias", Alias: "Printer"}, 2*time.Second)
	if ErrKind(err) != "readback_mismatch" || res == nil || res.RolledBack {
		t.Fatalf("a rollback that did not stick must not be reported as done: %v %+v", err, res)
	}
	if !strings.Contains(strings.Join(res.Steps, "\n"), "rollback not verified") {
		t.Fatalf("steps: %v", res.Steps)
	}
}
