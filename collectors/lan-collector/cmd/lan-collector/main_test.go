package main

import (
	"reflect"
	"testing"

	"github.com/lan-detective/lan-collector/internal/router"
)

func TestAllRouterVendorsRegistered(t *testing.T) {
	want := []string{"asus", "cisco_xe", "dlink", "fortigate", "huawei", "huawei_lte", "mikrotik", "omada", "openwrt", "opnsense", "pfsense", "tenda", "tplink_archer", "unifi", "zte", "zyxel"}
	got := router.Vendors()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("registered router vendors = %v, want %v", got, want)
	}
}
