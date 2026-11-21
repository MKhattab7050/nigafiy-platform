//go:build !windows

package launcher

// RegistryRuntime has no registry to read outside Windows.
func RegistryRuntime() (string, error) { return "", nil }
