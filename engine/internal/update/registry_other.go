//go:build !windows

package update

import "errors"

var errNotFound = errors.New("registry key not found")

// SystemRegistry is nil outside Windows: there is no registry, so nothing is detected.
func SystemRegistry() Registry { return nil }
