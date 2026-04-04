/**
 * Isomorphic BTP + ILP binary protocol.
 * Uses Uint8Array and DataView — no Buffer, no Node.js dependencies.
 *
 * BTP (Bilateral Transfer Protocol) message format:
 *   1 byte  — message type
 *   4 bytes — request ID (uint32 BE)
 *   variable — payload (MESSAGE data or ERROR data)
 *
 * ILP (Interledger Protocol) OER-encoded packets:
 *   PREPARE (type 12), FULFILL (type 13), REJECT (type 14)
 */

// ─── Text codec (isomorphic) ────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ─── BTP types ──────────────────────────────────────────────────────────────

export const BTPMessageType = {
  RESPONSE: 1,
  ERROR: 2,
  MESSAGE: 6,
} as const;

export const ILPPacketType = {
  PREPARE: 12,
  FULFILL: 13,
  REJECT: 14,
} as const;

export interface BTPProtocolData {
  protocolName: string;
  contentType: number;
  data: Uint8Array;
}

export interface BTPMessageData {
  protocolData: BTPProtocolData[];
  ilpPacket?: Uint8Array;
}

export interface BTPMessage {
  type: number;
  requestId: number;
  data: BTPMessageData | BTPErrorData;
}

export interface BTPErrorData {
  code: string;
  name: string;
  triggeredAt: string;
  data: Uint8Array;
}

export interface ILPPreparePacket {
  type: typeof ILPPacketType.PREPARE;
  amount: bigint;
  destination: string;
  executionCondition: Uint8Array;
  expiresAt: Date;
  data: Uint8Array;
}

export interface ILPFulfillPacket {
  type: typeof ILPPacketType.FULFILL;
  data: Uint8Array;
}

export interface ILPRejectPacket {
  type: typeof ILPPacketType.REJECT;
  code: string;
  message: string;
  data: Uint8Array;
}

export type ILPResponsePacket = ILPFulfillPacket | ILPRejectPacket;

// ─── Byte helpers ───────────────────────────────────────────────────────────

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function readUint8(buf: Uint8Array, offset: number): number {
  if (offset >= buf.length) throw new Error('Buffer underflow reading uint8');
  return buf[offset]!;
}

function readUint16BE(buf: Uint8Array, offset: number): number {
  if (offset + 2 > buf.length) throw new Error('Buffer underflow reading uint16');
  return (buf[offset]! << 8) | buf[offset + 1]!;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  if (offset + 4 > buf.length) throw new Error('Buffer underflow reading uint32');
  return ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
}

function writeUint8(value: number): Uint8Array {
  return new Uint8Array([value]);
}

function writeUint16BE(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function writeUint32BE(value: number): Uint8Array {
  return new Uint8Array([(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function sliceUtf8(buf: Uint8Array, offset: number, length: number): string {
  return textDecoder.decode(buf.slice(offset, offset + length));
}

// ─── OER encoding (ILP wire format) ─────────────────────────────────────────

function encodeVarUInt(value: bigint): Uint8Array {
  if (value >= 0n && value <= 127n) {
    return new Uint8Array([Number(value)]);
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0n) {
    bytes.unshift(Number(remaining & 0xffn));
    remaining = remaining >> 8n;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function decodeVarUInt(buf: Uint8Array, offset: number): { value: bigint; bytesRead: number } {
  const firstByte = readUint8(buf, offset);
  if (firstByte <= 127) {
    return { value: BigInt(firstByte), bytesRead: 1 };
  }
  const length = firstByte & 0x7f;
  if (offset + 1 + length > buf.length) throw new Error('VarUInt buffer underflow');
  let value = 0n;
  for (let i = 0; i < length; i++) {
    value = (value << 8n) | BigInt(buf[offset + 1 + i]!);
  }
  return { value, bytesRead: 1 + length };
}

function encodeVarOctetString(data: Uint8Array): Uint8Array {
  return concat(encodeVarUInt(BigInt(data.length)), data);
}

function decodeVarOctetString(buf: Uint8Array, offset: number): { value: Uint8Array; bytesRead: number } {
  const { value: length, bytesRead: lenBytes } = decodeVarUInt(buf, offset);
  const dataLen = Number(length);
  const start = offset + lenBytes;
  if (start + dataLen > buf.length) throw new Error('VarOctetString buffer underflow');
  return { value: buf.slice(start, start + dataLen), bytesRead: lenBytes + dataLen };
}

function encodeGeneralizedTime(date: Date): Uint8Array {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const mo = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  const mi = date.getUTCMinutes().toString().padStart(2, '0');
  const s = date.getUTCSeconds().toString().padStart(2, '0');
  const ms = date.getUTCMilliseconds().toString().padStart(3, '0');
  return textEncoder.encode(`${y}${mo}${d}${h}${mi}${s}.${ms}Z`);
}

// ─── ILP packet serialization ───────────────────────────────────────────────

export function serializeIlpPrepare(packet: ILPPreparePacket): Uint8Array {
  const condition = packet.executionCondition.length === 32
    ? packet.executionCondition
    : new Uint8Array(32);
  return concat(
    writeUint8(ILPPacketType.PREPARE),
    encodeVarUInt(packet.amount),
    encodeGeneralizedTime(packet.expiresAt),
    condition,
    encodeVarOctetString(textEncoder.encode(packet.destination)),
    encodeVarOctetString(packet.data),
  );
}

export function deserializeIlpPacket(buf: Uint8Array): ILPResponsePacket {
  if (buf.length === 0) throw new Error('Empty ILP packet');
  const type = buf[0]!;
  if (type === ILPPacketType.FULFILL) return deserializeIlpFulfill(buf);
  if (type === ILPPacketType.REJECT) return deserializeIlpReject(buf);
  throw new Error(`Unknown ILP packet type: ${type}`);
}

function deserializeIlpFulfill(buf: Uint8Array): ILPFulfillPacket {
  let offset = 1; // skip type byte
  // Skip 32-byte fulfillment (unused in TOON)
  offset += 32;
  const { value: data } = decodeVarOctetString(buf, offset);
  return { type: ILPPacketType.FULFILL, data };
}

function deserializeIlpReject(buf: Uint8Array): ILPRejectPacket {
  let offset = 1; // skip type byte
  // 3-byte error code
  const code = sliceUtf8(buf, offset, 3);
  offset += 3;
  // triggeredBy (skip)
  const { bytesRead: tbBytes } = decodeVarOctetString(buf, offset);
  offset += tbBytes;
  // message
  const { value: msgBuf, bytesRead: msgBytes } = decodeVarOctetString(buf, offset);
  offset += msgBytes;
  const message = textDecoder.decode(msgBuf);
  // data
  const { value: data } = decodeVarOctetString(buf, offset);
  return { type: ILPPacketType.REJECT, code, message, data };
}

// ─── BTP message serialization ──────────────────────────────────────────────

export function serializeBtpMessage(message: BTPMessage): Uint8Array {
  const parts: Uint8Array[] = [
    writeUint8(message.type),
    writeUint32BE(message.requestId),
  ];

  const data = message.data as BTPMessageData;
  const protocolData = data.protocolData ?? [];

  // Protocol data count
  parts.push(writeUint8(protocolData.length));

  // Each protocol data entry
  for (const pd of protocolData) {
    const nameBytes = textEncoder.encode(pd.protocolName);
    parts.push(writeUint8(nameBytes.length));
    parts.push(nameBytes);
    parts.push(writeUint16BE(pd.contentType));
    parts.push(writeUint32BE(pd.data.length));
    if (pd.data.length > 0) parts.push(pd.data);
  }

  // ILP packet
  const ilpPacket = data.ilpPacket ?? new Uint8Array(0);
  parts.push(writeUint32BE(ilpPacket.length));
  if (ilpPacket.length > 0) parts.push(ilpPacket);

  return concat(...parts);
}

export function parseBtpMessage(buf: Uint8Array): BTPMessage {
  if (buf.length < 5) throw new Error('BTP message too short');
  let offset = 0;

  const type = readUint8(buf, offset); offset += 1;
  const requestId = readUint32BE(buf, offset); offset += 4;

  if (type === BTPMessageType.ERROR) {
    // code
    const codeLen = readUint8(buf, offset); offset += 1;
    const code = sliceUtf8(buf, offset, codeLen); offset += codeLen;
    // name
    const nameLen = readUint8(buf, offset); offset += 1;
    const name = sliceUtf8(buf, offset, nameLen); offset += nameLen;
    // triggeredAt
    const taLen = readUint8(buf, offset); offset += 1;
    const triggeredAt = sliceUtf8(buf, offset, taLen); offset += taLen;
    // data
    const dataLen = readUint32BE(buf, offset); offset += 4;
    const data = buf.slice(offset, offset + dataLen);
    return { type, requestId, data: { code, name, triggeredAt, data } };
  }

  // MESSAGE or RESPONSE
  const pdCount = readUint8(buf, offset); offset += 1;
  const protocolData: BTPProtocolData[] = [];
  for (let i = 0; i < pdCount; i++) {
    const nameLen = readUint8(buf, offset); offset += 1;
    const protocolName = sliceUtf8(buf, offset, nameLen); offset += nameLen;
    const contentType = readUint16BE(buf, offset); offset += 2;
    const dataLen = readUint32BE(buf, offset); offset += 4;
    const data = buf.slice(offset, offset + dataLen); offset += dataLen;
    protocolData.push({ protocolName, contentType, data });
  }

  let ilpPacket: Uint8Array | undefined;
  if (offset + 4 <= buf.length) {
    const ilpLen = readUint32BE(buf, offset); offset += 4;
    if (ilpLen > 0 && offset + ilpLen <= buf.length) {
      ilpPacket = buf.slice(offset, offset + ilpLen);
    }
  }

  return { type, requestId, data: { protocolData, ilpPacket } };
}
