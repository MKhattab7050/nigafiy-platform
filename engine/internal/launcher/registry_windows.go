//go:build windows

package launcher

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

// RegistryRuntime reads HKCU, then HKLM, `Software\Nigafiy\Runtime` `Path` (read-only access).
// It returns "" with a nil error when neither is set.
func RegistryRuntime() (string, error) {
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		k, err := registry.OpenKey(root, RegistryKey, registry.QUERY_VALUE)
		if err != nil {
			if errors.Is(err, registry.ErrNotExist) {
				continue
			}
			return "", err
		}
		v, _, err := k.GetStringValue(RegistryValue)
		_ = k.Close()
		if err == nil && v != "" {
			return v, nil
		}
		if err != nil && !errors.Is(err, registry.ErrNotExist) {
			return "", err
		}
	}
	return "", nil
}
