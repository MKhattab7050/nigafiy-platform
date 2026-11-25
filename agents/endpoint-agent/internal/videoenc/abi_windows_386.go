package videoenc

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/windows"
)

// x86 stdcall: a 16-byte struct passed by value goes on the stack as four 32-bit words.
func guidArgs(g *windows.GUID) []uintptr {
	b := (*[16]byte)(unsafe.Pointer(g))
	return []uintptr{
		uintptr(binary.LittleEndian.Uint32(b[0:])), uintptr(binary.LittleEndian.Uint32(b[4:])),
		uintptr(binary.LittleEndian.Uint32(b[8:])), uintptr(binary.LittleEndian.Uint32(b[12:])),
	}
}

// A 64-bit integer is two stack words, low first.
func u64Args(v uint64) []uintptr { return []uintptr{uintptr(uint32(v)), uintptr(uint32(v >> 32))} }
