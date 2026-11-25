package videoenc

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ARM64 calling convention: a 16-byte struct passed by value goes in two integer registers.
func guidArgs(g *windows.GUID) []uintptr {
	b := (*[16]byte)(unsafe.Pointer(g))
	return []uintptr{uintptr(binary.LittleEndian.Uint64(b[:8])), uintptr(binary.LittleEndian.Uint64(b[8:]))}
}

// A 64-bit integer is one register.
func u64Args(v uint64) []uintptr { return []uintptr{uintptr(v)} }
