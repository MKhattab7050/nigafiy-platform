//go:build windows

package update

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

var errNotFound = errors.New("registry key not found")

// SystemRegistry reads the real registry (64-bit view), read-only.
func SystemRegistry() Registry { return winRegistry{} }

type winRegistry struct{}

func openKey(root, path string) (registry.Key, error) {
	var r registry.Key
	switch root {
	case "HKLM":
		r = registry.LOCAL_MACHINE
	case "HKCU":
		r = registry.CURRENT_USER
	default:
		return 0, errNotFound
	}
	return registry.OpenKey(r, path, registry.READ|registry.WOW64_64KEY)
}

func (winRegistry) SubKeys(root, path string) ([]string, error) {
	k, err := openKey(root, path)
	if err != nil {
		return nil, err
	}
	defer k.Close()
	return k.ReadSubKeyNames(-1)
}

func (winRegistry) ValueNames(root, path string) ([]string, error) {
	k, err := openKey(root, path)
	if err != nil {
		return nil, err
	}
	defer k.Close()
	return k.ReadValueNames(-1)
}

func (winRegistry) String(root, path, name string) (string, bool) {
	k, err := openKey(root, path)
	if err != nil {
		return "", false
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	return v, err == nil
}

func (winRegistry) Integer(root, path, name string) (uint64, bool) {
	k, err := openKey(root, path)
	if err != nil {
		return 0, false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue(name)
	return v, err == nil
}
