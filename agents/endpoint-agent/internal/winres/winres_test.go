package winres

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"testing"
)

const testManifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"></assembly>
`

func TestManifestObjectIsAValidCOFFResourceObject(t *testing.T) {
	obj, err := ManifestObject([]byte(testManifest))
	if err != nil {
		t.Fatal(err)
	}
	f, err := pe.NewFile(bytes.NewReader(obj))
	if err != nil {
		t.Fatalf("debug/pe cannot read the object: %v", err)
	}
	if f.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || len(f.Sections) != 1 {
		t.Fatalf("machine %#x sections %d", f.Machine, len(f.Sections))
	}
	s := f.Sections[0]
	if s.Name != ".rsrc" || s.Characteristics != sectionFlags {
		t.Fatalf("section %q %#x", s.Name, s.Characteristics)
	}
	if len(s.Relocs) != 1 || s.Relocs[0].VirtualAddress != dataEntryOff || s.Relocs[0].Type != relAMD64Addr32NB || s.Relocs[0].SymbolTableIndex != 0 {
		t.Fatalf("relocs %+v", s.Relocs)
	}
	if len(f.Symbols) != 1 || f.Symbols[0].Name != ".rsrc" || f.Symbols[0].SectionNumber != 1 || f.Symbols[0].StorageClass != symClassStatic {
		t.Fatalf("symbols %+v", f.Symbols)
	}
	data, err := s.Data()
	if err != nil {
		t.Fatal(err)
	}
	le := binary.LittleEndian
	// Walk type -> name -> language -> data entry the way Windows does.
	walk := func(dirOff uint32) (id, next uint32) {
		if n := le.Uint16(data[dirOff+12:]); n != 0 {
			t.Fatalf("named entries at %d: %d", dirOff, n)
		}
		if n := le.Uint16(data[dirOff+14:]); n != 1 {
			t.Fatalf("id entries at %d: %d", dirOff, n)
		}
		return le.Uint32(data[dirOff+16:]), le.Uint32(data[dirOff+20:])
	}
	id, next := walk(0)
	if id != rtManifest || next&subdirFlag == 0 {
		t.Fatalf("type %d %#x", id, next)
	}
	id, next = walk(next &^ subdirFlag)
	if id != manifestID || next&subdirFlag == 0 {
		t.Fatalf("name %d %#x", id, next)
	}
	id, next = walk(next &^ subdirFlag)
	if id != langEnUS || next&subdirFlag != 0 {
		t.Fatalf("lang %#x %#x", id, next)
	}
	off, size := le.Uint32(data[next:]), le.Uint32(data[next+4:])
	if got := string(data[off : off+size]); got != testManifest {
		t.Fatalf("manifest bytes %q", got)
	}
	if len(data)%8 != 0 {
		t.Fatalf("section size %d not 8-aligned", len(data))
	}
	again, _ := ManifestObject([]byte(testManifest))
	if !bytes.Equal(obj, again) {
		t.Fatal("not deterministic")
	}
}

func TestManifestObjectRejectsNonManifests(t *testing.T) {
	for _, in := range []string{"", "hello"} {
		if _, err := ManifestObject([]byte(in)); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}
