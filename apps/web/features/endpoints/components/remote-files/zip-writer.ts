// A streaming ZIP writer for folder and multi-file downloads. Entries are stored (not compressed:
// the bytes come over the network once and are written once; photos, videos and archives would
// not shrink anyway), every size is known before its bytes arrive (walk), and the CRC-32 is
// written into the local header after the data (the sink can write at a position), so no data
// descriptors are needed. ZIP64 records are added for an entry or archive past 4 GiB or 65 535
// entries, which Windows Explorer, macOS Archive Utility and 7-Zip all open.

export interface ZipSink {
  /** Appends at the end. */
  write(data: Uint8Array): Promise<void>;
  /** Overwrites bytes already written (the CRC of a local header). */
  writeAt(position: number, data: Uint8Array): Promise<void>;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export class Crc32 {
  private c = 0xffffffff;
  update(d: Uint8Array): this {
    let c = this.c;
    for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]!) & 0xff]! ^ (c >>> 8);
    this.c = c;
    return this;
  }
  value(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

const MAX32 = 0xffffffff;
const enc = new TextEncoder();

function dosDateTime(iso?: string): { time: number; date: number } {
  const d = iso ? new Date(iso) : new Date();
  const y = Number.isNaN(d.getTime()) ? new Date() : d;
  const year = Math.max(1980, y.getFullYear());
  return {
    time: (y.getHours() << 11) | (y.getMinutes() << 5) | Math.floor(y.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((y.getMonth() + 1) << 5) | y.getDate(),
  };
}

class Bytes {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16(Math.floor(v / 0x10000) & 0xffff);
  }
  u64(v: number) {
    return this.u32(v % 0x1_0000_0000).u32(Math.floor(v / 0x1_0000_0000));
  }
  raw(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  get size() {
    return this.parts.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

interface Written {
  name: Uint8Array;
  size: number;
  crc: number;
  offset: number;
  dir: boolean;
  time: { time: number; date: number };
}

/** Writes one archive: begin each entry, feed its bytes, end it; finish writes the directory. */
export class ZipWriter {
  private pos = 0;
  private entries: Written[] = [];
  private current: { w: Written; crc: Crc32; written: number; crcAt: number; zip64: boolean } | null = null;

  private sink: ZipSink;
  constructor(sink: ZipSink) {
    this.sink = sink;
  }

  get position(): number {
    return this.pos;
  }

  private async put(b: Uint8Array) {
    await this.sink.write(b);
    this.pos += b.length;
  }

  /** A folder entry ("name/"), so empty folders are kept. */
  async addFolder(path: string, modTime?: string) {
    await this.begin(path.replace(/\/?$/, '/'), 0, modTime, true);
    await this.end();
  }

  /** Starts a file entry of exactly `size` bytes at `path` (forward slashes, no leading slash). */
  async begin(path: string, size: number, modTime?: string, dir = false) {
    if (this.current) throw new Error('zip: previous entry not ended');
    const name = enc.encode(path.replace(/^\/+/, ''));
    const offset = this.pos;
    const zip64 = size >= MAX32 || offset >= MAX32;
    const time = dosDateTime(modTime);
    const h = new Bytes()
      .u32(0x04034b50)
      .u16(zip64 ? 45 : 20)
      .u16(0x0800) // UTF-8 names
      .u16(0) // stored
      .u16(time.time)
      .u16(time.date);
    const crcAt = offset + h.size;
    h.u32(0) // CRC, written after the data
      .u32(zip64 ? MAX32 : size)
      .u32(zip64 ? MAX32 : size)
      .u16(name.length)
      .u16(zip64 ? 20 : 0)
      .raw(name);
    if (zip64) h.u16(0x0001).u16(16).u64(size).u64(size);
    await this.put(h.done());
    this.current = { w: { name, size, crc: 0, offset, dir, time }, crc: new Crc32(), written: 0, crcAt, zip64 };
  }

  async data(chunk: Uint8Array) {
    const c = this.current;
    if (!c) throw new Error('zip: no entry');
    if (c.written + chunk.length > c.w.size) throw new Error('zip: the file grew while it was copied');
    c.crc.update(chunk);
    c.written += chunk.length;
    await this.put(chunk);
  }

  async end() {
    const c = this.current;
    if (!c) throw new Error('zip: no entry');
    if (c.written !== c.w.size) throw new Error('zip: the file changed size while it was copied');
    c.w.crc = c.crc.value();
    await this.sink.writeAt(c.crcAt, new Bytes().u32(c.w.crc).done());
    this.entries.push(c.w);
    this.current = null;
  }

  /** Writes the central directory (and the ZIP64 end records when needed). */
  async finish() {
    if (this.current) throw new Error('zip: entry not ended');
    const cdStart = this.pos;
    for (const e of this.entries) {
      const big = e.size >= MAX32;
      const far = e.offset >= MAX32;
      const extra = new Bytes();
      if (big || far) {
        extra.u16(0x0001).u16((big ? 16 : 0) + (far ? 8 : 0));
        if (big) extra.u64(e.size).u64(e.size);
        if (far) extra.u64(e.offset);
      }
      const ex = extra.done();
      const h = new Bytes()
        .u32(0x02014b50)
        .u16(45 | (3 << 8)) // made by: Unix (keeps folder bits meaningful), version 4.5
        .u16(big || far ? 45 : 20)
        .u16(0x0800)
        .u16(0)
        .u16(e.time.time)
        .u16(e.time.date)
        .u32(e.crc)
        .u32(big ? MAX32 : e.size)
        .u32(big ? MAX32 : e.size)
        .u16(e.name.length)
        .u16(ex.length)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(e.dir ? (0o40755 << 16) | 0x10 : (0o100644 << 16) >>> 0)
        .u32(far ? MAX32 : e.offset)
        .raw(e.name)
        .raw(ex);
      await this.put(h.done());
    }
    const cdSize = this.pos - cdStart;
    const count = this.entries.length;
    const need64 = count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (need64) {
      const eocd64At = this.pos;
      await this.put(
        new Bytes().u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdStart).done(),
      );
      await this.put(new Bytes().u32(0x07064b50).u32(0).u64(eocd64At).u32(1).done());
    }
    await this.put(
      new Bytes()
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(need64 ? 0xffff : count)
        .u16(need64 ? 0xffff : count)
        .u32(need64 ? MAX32 : cdSize)
        .u32(need64 ? MAX32 : cdStart)
        .u16(0)
        .done(),
    );
  }
}

/** A ZIP kept in memory (browsers without File System Access): fine for a few hundred MB. */
export class MemoryZipSink implements ZipSink {
  parts: Uint8Array[] = [];
  private starts: number[] = [];
  private end = 0;
  async write(data: Uint8Array) {
    this.starts.push(this.end);
    this.parts.push(data);
    this.end += data.length;
  }
  async writeAt(position: number, data: Uint8Array) {
    // Patches always land inside one header part (the CRC field).
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const s = this.starts[i]!;
      if (position >= s && position + data.length <= s + this.parts[i]!.length) {
        this.parts[i]!.set(data, position - s);
        return;
      }
    }
    throw new Error('zip: patch outside the written data');
  }
  blob(): Blob {
    return new Blob(this.parts as BlobPart[], { type: 'application/zip' });
  }
}
