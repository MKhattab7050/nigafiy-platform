// Package winres writes a Windows resource object (.syso) that holds one application manifest
// (RT_MANIFEST, ID 1, language en-US), so a pure-Go program gets the manifest Windows and the
// Windows App Certification Kit read (DPI awareness, supported OS, execution level). The Go linker
// links every *_windows_amd64.syso in a package directory into that package's program and tests.
//
// The object is a minimal x64 COFF file: one .rsrc section with the resource directory tree
// (type -> name -> language -> data entry) and the manifest bytes, one IMAGE_REL_AMD64_ADDR32NB
// relocation for the data entry's RVA, and the section symbol the relocation refers to. No cgo,
// no external tool, no download.
package winres

import (
	"bytes"
	"encoding/binary"
	"errors"
)

const (
	machineAMD64     = 0x8664
	relAMD64Addr32NB = 0x0003
	rtManifest       = 24
	manifestID       = 1
	langEnUS         = 0x0409
	sectionFlags     = 0x40000040 // IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ
	subdirFlag       = 0x80000000
	symClassStatic   = 3

	fileHeaderSize    = 20
	sectionHeaderSize = 40
	dirSize           = 16 // IMAGE_RESOURCE_DIRECTORY
	entrySize         = 8  // IMAGE_RESOURCE_DIRECTORY_ENTRY
	dataEntrySize     = 16 // IMAGE_RESOURCE_DATA_ENTRY

	// Offsets inside the .rsrc section.
	nameDirOff   = dirSize + entrySize
	langDirOff   = nameDirOff + dirSize + entrySize
	dataEntryOff = langDirOff + dirSize + entrySize
	manifestOff  = dataEntryOff + dataEntrySize
)

// ManifestObject returns the bytes of an x64 COFF object holding manifest as resource
// RT_MANIFEST #1 (en-US). CRLF line endings become LF first, so a checkout with
// core.autocrlf gives the same object as one without.
func ManifestObject(manifest []byte) ([]byte, error) {
	manifest = bytes.ReplaceAll(manifest, []byte("\r\n"), []byte("\n"))
	if len(manifest) == 0 {
		return nil, errors.New("winres: empty manifest")
	}
	if !bytes.Contains(manifest, []byte("<assembly")) {
		return nil, errors.New("winres: not an application manifest (no <assembly> element)")
	}

	var sect bytes.Buffer
	le := binary.LittleEndian
	w := func(v any) { _ = binary.Write(&sect, le, v) }
	dir := func(idEntries uint16) {
		w(uint32(0)) // Characteristics
		w(uint32(0)) // TimeDateStamp
		w(uint16(0)) // MajorVersion
		w(uint16(0)) // MinorVersion
		w(uint16(0)) // NumberOfNamedEntries
		w(uint16(idEntries))
	}
	dir(1)
	w(uint32(rtManifest))
	w(uint32(subdirFlag | nameDirOff))
	dir(1)
	w(uint32(manifestID))
	w(uint32(subdirFlag | langDirOff))
	dir(1)
	w(uint32(langEnUS))
	w(uint32(dataEntryOff))
	// Data entry: OffsetToData is an RVA. It holds the offset inside the section; the
	// ADDR32NB relocation below adds the section's RVA when the program is linked.
	w(uint32(manifestOff))
	w(uint32(len(manifest)))
	w(uint32(0)) // CodePage
	w(uint32(0)) // Reserved
	sect.Write(manifest)
	for sect.Len()%8 != 0 {
		sect.WriteByte(0)
	}

	rawOff := uint32(fileHeaderSize + sectionHeaderSize)
	relocOff := rawOff + uint32(sect.Len())
	const relocSize = 10
	symOff := relocOff + relocSize

	var out bytes.Buffer
	o := func(v any) { _ = binary.Write(&out, le, v) }
	// IMAGE_FILE_HEADER
	o(uint16(machineAMD64))
	o(uint16(1)) // NumberOfSections
	o(uint32(0)) // TimeDateStamp (0: the same input gives the same bytes)
	o(symOff)    // PointerToSymbolTable
	o(uint32(1)) // NumberOfSymbols
	o(uint16(0)) // SizeOfOptionalHeader
	o(uint16(0)) // Characteristics
	// IMAGE_SECTION_HEADER
	out.Write([]byte(".rsrc\x00\x00\x00"))
	o(uint32(0)) // VirtualSize
	o(uint32(0)) // VirtualAddress
	o(uint32(sect.Len()))
	o(rawOff)
	o(relocOff)
	o(uint32(0)) // PointerToLinenumbers
	o(uint16(1)) // NumberOfRelocations
	o(uint16(0)) // NumberOfLinenumbers
	o(uint32(sectionFlags))
	out.Write(sect.Bytes())
	// IMAGE_RELOCATION: the data entry's OffsetToData, against symbol 0 (.rsrc).
	o(uint32(dataEntryOff))
	o(uint32(0))
	o(uint16(relAMD64Addr32NB))
	// IMAGE_SYMBOL .rsrc, section 1, static.
	out.Write([]byte(".rsrc\x00\x00\x00"))
	o(uint32(0)) // Value
	o(int16(1))  // SectionNumber
	o(uint16(0)) // Type
	out.WriteByte(symClassStatic)
	out.WriteByte(0) // NumberOfAuxSymbols
	// String table: just its own 4-byte size.
	o(uint32(4))
	return out.Bytes(), nil
}
