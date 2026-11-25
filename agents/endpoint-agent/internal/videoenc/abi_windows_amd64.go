package videoenc

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// x64 calling convention: a 16-byte struct passed by value goes as a pointer to a copy.
func guidArgs(g *windows.GUID) []uintptr {
	cp := *g
	return []uintptr{uintptr(unsafe.Pointer(&cp))}
}

// A 64-bit integer is one register.
func u64Args(v uint64) []uintptr { return []uintptr{uintptr(v)} }
