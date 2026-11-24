package tenda

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/nigafiy/sensor/internal/router"
)

// Rename on Tenda AC routers with the V15.03 firmware family (AC6, AC7, AC9, AC10, AC11, AC15, AC18):
// the "Attached Devices" page renames a client with POST /goform/SetOnlineDevName (form fields `mac`
// and `devName`, handler formSetDeviceName), and the new name shows in the online list.
//
// Sources: the endpoint and its two parameters are documented in the public advisories for that
// handler — CVE-2024-10662 (AC15 V15.03.05.19), CVE-2024-10698 (AC6 V15.03.05.19), CVE-2024-0533
// (A15 V15.13.07.13), CVE-2023-49428 / CVE-2023-49431 (AX9/AX12, `mac` parameter). The advisories
// are about a stack overflow on a long `devName` and command injection through `mac` on AX models,
// so this driver only ever sends a normalised MAC and a name of at most 32 bytes without control
// characters. Other Tenda firmware families (F3 V12.x, AC23 V16.x) are not confirmed to have the
// handler, so rename stays unsupported there.
const mechRename = "Tenda attached-device name (/goform/SetOnlineDevName)"

// maxTendaNameBytes keeps devName well inside the handler's fixed buffer (see the advisories above).
const maxTendaNameBytes = 32

var _ router.Renamer = (*Driver)(nil)

// renameSupported: the V15.03 firmware family, where SetOnlineDevName is confirmed.
func renameSupported(firmware string) bool {
	fw := strings.ToUpper(strings.TrimSpace(firmware))
	return strings.HasPrefix(fw, "V15.03.") || strings.HasPrefix(fw, "15.03.")
}

func renameCapability(info *router.Info) router.CapabilityStatus {
	fw := ""
	if info != nil {
		fw = info.Firmware
	}
	if renameSupported(fw) {
		return router.CapabilityStatus{Capability: router.CapRename, Supported: true, Mechanism: mechRename,
			Note: "Tenda keeps at most 32 bytes of a device name"}
	}
	if fw == "" {
		fw = "unknown version"
	}
	return router.CapabilityStatus{Capability: router.CapRename, Supported: false,
		Note: "Renaming is confirmed only on Tenda firmware V15.03 (AC6/AC10/AC15 family, /goform/SetOnlineDevName); this router runs " + fw}
}

func (d *Driver) clientName(ctx context.Context, mac string) (string, bool, error) {
	cs, err := d.Clients(ctx)
	if err != nil {
		return "", false, err
	}
	for _, c := range cs {
		if c.MAC == mac {
			return c.Hostname, true, nil
		}
	}
	return "", false, nil
}

// RenameClient sets the device name Tenda shows for a client in its online list and re-reads it.
func (d *Driver) RenameClient(ctx context.Context, rawMAC, rawName string) (router.Change, error) {
	mac, err := router.NormalizeMAC(rawMAC)
	if err != nil {
		return router.Change{}, err
	}
	name, err := router.CleanName(rawName)
	if err != nil {
		return router.Change{}, err
	}
	if len(name) > maxTendaNameBytes {
		return router.Change{}, router.Errorf(router.ErrInvalidArgument, "rename", "Tenda keeps at most %d bytes of a device name", maxTendaNameBytes)
	}
	if d.info == nil {
		if _, err := d.Identify(ctx); err != nil {
			return router.Change{}, err
		}
	}
	if !renameSupported(d.info.Firmware) {
		return router.Change{}, router.Errorf(router.ErrUnsupported, "rename", "%s", renameCapability(d.info).Note)
	}
	old, present, err := d.clientName(ctx, mac)
	if err != nil {
		return router.Change{}, err
	}
	if !present {
		return router.Change{}, router.Errorf(router.ErrNotFound, "rename", "the Tenda router does not list %s as a client", mac)
	}
	if old == name {
		return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: false, AlreadyInEffect: true, Detail: fmt.Sprintf("%s is already named %q", mac, name)}, nil
	}
	if !d.loggedIn {
		if err := d.login(ctx); err != nil {
			return router.Change{}, err
		}
	}
	st, raw, err := d.rawDo(ctx, "rename", http.MethodPost, "/goform/SetOnlineDevName", url.Values{"mac": {mac}, "devName": {name}})
	if err != nil {
		return router.Change{}, err
	}
	var res struct {
		ErrCode *int `json:"errCode"`
	}
	if st != http.StatusOK || json.Unmarshal(raw, &res) != nil || res.ErrCode == nil || *res.ErrCode != 0 {
		code := "none"
		if res.ErrCode != nil {
			code = fmt.Sprint(*res.ErrCode)
		}
		return router.Change{}, router.Errorf(router.ErrRejected, "rename", "Tenda SetOnlineDevName answered HTTP %d, errCode %s", st, code)
	}
	got, _, err := d.clientName(ctx, mac)
	if err != nil {
		return router.Change{}, err
	}
	if got != name {
		return router.Change{}, router.Errorf(router.ErrProtocol, "rename", "Tenda accepted the change but still shows %s as %q", mac, got)
	}
	undo := "Rename it back in Nigafiy, or under Attached Devices on the Tenda router"
	if old != "" {
		undo = fmt.Sprintf("Rename it back to %q in Nigafiy, or under Attached Devices on the Tenda router", old)
	}
	return router.Change{Action: "rename", MAC: mac, Mechanism: mechRename, Applied: true, Detail: fmt.Sprintf("renamed %s to %q on the Tenda router", mac, name), Undo: undo}, nil
}
