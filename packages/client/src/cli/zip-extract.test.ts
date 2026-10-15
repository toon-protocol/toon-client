import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractZip } from './zip-extract.js';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (d: Buffer): number => {
  let c = 0xffffffff;
  for (const b of d) c = (CRC[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

interface Spec {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  badCrc?: boolean;
  flags?: number;
}

function buildZip(specs: Spec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const data = s.data ?? Buffer.alloc(0);
    const method = s.method ?? 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (crc32(data) ^ (s.badCrc ? 1 : 0)) >>> 0;
    const name = Buffer.from(s.name);
    const flags = s.flags ?? 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const dirs: string[] = [];
function scratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(specs: Spec[]): { root: string; dest: string; error?: Error } {
  const root = scratch();
  const dest = path.join(root, 'dest');
  const zip = path.join(root, 'a.zip');
  fs.writeFileSync(zip, buildZip(specs));
  try {
    extractZip(zip, dest);
    return { root, dest };
  } catch (error) {
    return { root, dest, error: error as Error };
  }
}

describe('extractZip', () => {
  it('extracts stored, deflated and nested entries byte for byte', () => {
    const a = Buffer.from('stored bytes');
    const b = Buffer.alloc(5000, 'deflate me ');
    const { dest, error } = run([
      { name: 'anon', data: a, method: 0 },
      { name: 'sub/' },
      { name: 'sub/deep/lib.so', data: b, method: 8 },
    ]);
    expect(error).toBeUndefined();
    expect(fs.readFileSync(path.join(dest, 'anon'))).toEqual(a);
    expect(fs.readFileSync(path.join(dest, 'sub/deep/lib.so'))).toEqual(b);
  });

  it.each(['../evil', '/abs/evil', 'a/../../evil', '..\\evil', 'C:evil'])(
    'refuses %s and writes nothing outside',
    (name) => {
      const { root, dest, error } = run([
        { name: 'ok', data: Buffer.from('x') },
        { name, data: Buffer.from('pwn') },
      ]);
      expect(error?.message).toMatch(/escapes the destination/);
      expect(fs.existsSync(path.join(root, 'evil'))).toBe(false);
      expect(fs.existsSync(path.join(dest, 'ok'))).toBe(false);
    }
  );

  it.each([0, 8] as const)('refuses a bad CRC-32 (method %i)', (method) => {
    const { dest, error } = run([{ name: 'anon', data: Buffer.from('hello'), method, badCrc: true }]);
    expect(error?.message).toMatch(/CRC-32 mismatch/);
    expect(fs.existsSync(path.join(dest, 'anon'))).toBe(false);
  });

  it('refuses encrypted entries', () => {
    const { error } = run([{ name: 'anon', data: Buffer.from('x'), flags: 1 }]);
    expect(error?.message).toMatch(/encrypted/);
  });

  it('refuses something that is not a zip', () => {
    const root = scratch();
    const zip = path.join(root, 'a.zip');
    fs.writeFileSync(zip, 'nope');
    expect(() => extractZip(zip, path.join(root, 'd'))).toThrow(/end-of-central-directory/);
  });
});
