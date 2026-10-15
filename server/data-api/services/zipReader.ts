/**
 * Just enough of a ZIP reader to open an EPUB.
 *
 * An EPUB is a ZIP whose entries are stored or deflated, and nothing here
 * needs more: no writing, no encryption, no ZIP64 (an EPUB past 4 GB is not a
 * book anyone reads on a phone). The central directory is read once; an entry
 * is inflated when asked for. node:zlib does the inflating, so this adds no
 * dependency — the image ships no `unzip`, and the extractor it replaces was a
 * macOS binary.
 */

import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface Entry {
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipError extends Error {}

export class ZipReader {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly buf: Buffer) {
    // The end-of-central-directory record sits in the last 22 bytes, plus a
    // comment of at most 64 KiB: search backwards for its signature.
    const floor = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= floor; i--) {
      if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError("not a zip archive (no end of central directory)");

    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    if (at === 0xffffffff) throw new ZipError("zip64 archives are not supported");

    for (let n = 0; n < count; n++) {
      if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
        throw new ZipError("corrupt central directory");
      }
      const nameLen = buf.readUInt16LE(at + 28);
      const extraLen = buf.readUInt16LE(at + 30);
      const commentLen = buf.readUInt16LE(at + 32);
      const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
      this.entries.set(name, {
        flags: buf.readUInt16LE(at + 8),
        method: buf.readUInt16LE(at + 10),
        compressedSize: buf.readUInt32LE(at + 20),
        size: buf.readUInt32LE(at + 24),
        localOffset: buf.readUInt32LE(at + 42),
      });
      at += 46 + nameLen + extraLen + commentLen;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The entry's bytes, or null when the archive has no such name. */
  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.flags & 0x1) throw new ZipError(`${name} is encrypted`);
    const at = e.localOffset;
    if (this.buf.readUInt32LE(at) !== LOCAL) throw new ZipError(`corrupt local header for ${name}`);
    // The local header's own name and extra lengths, not the central ones:
    // the two extra fields are allowed to differ.
    const start = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28);
    const raw = this.buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return inflateRawSync(raw);
    throw new ZipError(`${name}: unsupported compression method ${e.method}`);
  }

  text(name: string): string | null {
    return this.read(name)?.toString("utf8") ?? null;
  }
}
