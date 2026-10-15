/**
 * An in-process zip extractor for the pinned `anon` release — the CLI's, and only the CLI's
 * (ADR 0001). Node has no zip reader and the platform's own tool is not always installed, so
 * this reads exactly what the release assets use and refuses everything else.
 *
 * Supported: the end-of-central-directory record and the central directory; stored (0) and
 * deflated (8) entries; directory entries. Refused, loudly: zip64, encryption, other methods,
 * symlinks, a CRC-32 or size mismatch, and any entry whose path leaves the destination.
 *
 * Every entry is inflated and verified in memory before the first byte is written, so a bad
 * archive leaves nothing behind that could pass for a cached binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  isDirectory: boolean;
}

function fail(zipPath: string, why: string): never {
  throw new Error(`Cannot extract ${zipPath}: ${why}`);
}

/** The destination path for an entry, or null when it would escape `destDir`. */
function containedPath(destDir: string, name: string): string | null {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return null;
  }
  if (name.split('/').includes('..')) return null;
  const root = path.resolve(destDir);
  const target = path.resolve(root, name);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function readEntries(zipPath: string, buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail(zipPath, 'no end-of-central-directory record (not a zip file?)');

  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    fail(zipPath, 'zip64 archives are not supported');
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    fail(zipPath, 'zip64 archives are not supported');
  }
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    fail(zipPath, 'multi-disk archives are not supported');
  }

  const entries: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      fail(zipPath, 'corrupt central directory');
    }
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      fail(zipPath, `zip64 entry "${name}" is not supported`);
    }
    if (flags & 0x1 || flags & 0x40) fail(zipPath, `entry "${name}" is encrypted`);
    const isDirectory = name.endsWith('/');
    if (!isDirectory && method !== 0 && method !== 8) {
      fail(zipPath, `entry "${name}" uses unsupported compression method ${method}`);
    }
    // Unix host (3): the high half of the external attributes is st_mode.
    if (madeBy >> 8 === 3 && ((externalAttrs >>> 16) & 0xf000) === 0xa000) {
      fail(zipPath, `entry "${name}" is a symbolic link`);
    }
    entries.push({ name, method, crc, compressedSize, size, localOffset, isDirectory });
  }
  return entries;
}

function readData(zipPath: string, buf: Buffer, e: Entry): Buffer {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) {
    fail(zipPath, `corrupt local header for "${e.name}"`);
  }
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  if (start + e.compressedSize > buf.length) fail(zipPath, `entry "${e.name}" is truncated`);
  const raw = buf.subarray(start, start + e.compressedSize);

  let data: Buffer;
  if (e.method === 0) {
    data = raw;
  } else {
    try {
      data = zlib.inflateRawSync(raw);
    } catch (err) {
      return fail(zipPath, `entry "${e.name}" does not inflate: ${(err as Error).message}`);
    }
  }
  if (data.length !== e.size) {
    fail(zipPath, `size mismatch for "${e.name}": expected ${e.size}, got ${data.length}`);
  }
  if (crc32(data) !== e.crc) fail(zipPath, `CRC-32 mismatch for "${e.name}"`);
  return data;
}

/** Extract `zipPath` into `destDir`. Throws before writing anything if the archive is unacceptable. */
export function extractZip(zipPath: string, destDir: string): void {
  const buf = fs.readFileSync(zipPath);
  const entries = readEntries(zipPath, buf);

  const planned = entries.map((e) => {
    const target = containedPath(destDir, e.name);
    if (target === null) fail(zipPath, `entry "${e.name}" escapes the destination directory`);
    return { e, target, data: e.isDirectory ? null : readData(zipPath, buf, e) };
  });

  fs.mkdirSync(destDir, { recursive: true });
  for (const { e, target, data } of planned) {
    if (e.isDirectory || data === null) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write beside the target and rename, so the final name only ever holds a whole file.
    const partial = `${target}.partial`;
    try {
      fs.writeFileSync(partial, data);
      fs.renameSync(partial, target);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }
}
