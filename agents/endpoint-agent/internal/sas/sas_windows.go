//go:build windows

package sas

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

var (
	sasDLL   = syscall.NewLazyDLL("sas.dll")
	pSendSAS = sasDLL.NewProc("SendSAS")
)

func policyValue() (uint32, bool, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return 0, false, nil
		}
		return 0, false, err
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SoftwareSASGeneration")
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return 0, false, nil
		}
		return 0, false, err
	}
	return uint32(v), true, nil
}

func send() error {
	if err := pSendSAS.Find(); err != nil {
		return &Refusal{Code: CodeUnsupported, Message: "sas.dll is not available on this edition of Windows"}
	}
	// SendSAS(FALSE): the caller is a service. It returns nothing; Windows ignores it when the
	// policy does not allow it (checked above).
	_, _, _ = pSendSAS.Call(0)
	return nil
}
