// Git object storage and smart HTTP protocol implementation

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, Inflate } from 'node:zlib';
import { storage } from './storage.ts';
import type { GitObject, TreeEntry, CommitData, Ref } from './storage.ts';const PKT_LINE_MAX = 65520;

// ============================================================================
// Git Object Helpers
// ============================================================================

function objectHeader(type: string, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

export function hashObject(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(objectHeader(type, data.length));
  hash.update(data);
  return hash.digest('hex');
}

export function encodeLooseObject(type: string, data: Buffer): Buffer {
  return Buffer.concat([objectHeader(type, data.length), data]);
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  const commit: CommitData = { tree: '', parents: [], author: '', committer: '', message: '' };
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  commit.message = lines.slice(i + 1).join('\n');
  return commit;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const mode = data.subarray(offset, spaceIdx).toString('ascii');
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = data.subarray(spaceIdx + 1, nullIdx).toString('utf8');
    const sha = data.subarray(nullIdx + 1, nullIdx + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nullIdx + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? a.name + '/' : a.name;
    const bKey = b.mode === '40000' ? b.name + '/' : b.name;
    return aKey.localeCompare(bKey);
  });
  let data = Buffer.alloc(0);
  for (const entry of sorted) {
    const modeBuf = Buffer.from(entry.mode + ' ', 'utf8');
    const nameBuf = Buffer.from(entry.name + '\0', 'utf8');
    const shaBuf = Buffer.from(entry.sha, 'hex');
    data = Buffer.concat([data, modeBuf, nameBuf, shaBuf]);
  }
  return data;
}

export function buildCommit(commit: CommitData): Buffer {
  let data = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) {
    data += `parent ${parent}\n`;
  }
  data += `author ${commit.author}\n`;
  data += `committer ${commit.committer}\n`;
  data += `\n${commit.message}`;
  if (!data.endsWith('\n')) data += '\n';
  return Buffer.from(data, 'utf8');
}

// ============================================================================
// Pkt-line Encoding/Decoding
// ============================================================================

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) {
    throw new Error(`pkt-line payload too long: ${data.length}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function encodePktLines(items: (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('pkt-line decoder received bytes after finish()');
    if (!chunk.length) return;
    this.chunks.push(Buffer.from(chunk));
    this.buffered += chunk.length;
  }

  finish(): void {
    this.ended = true;
  }

  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  private take(n: number): Buffer {
    if (this.buffered < n) throw new Error('pkt-line decoder underrun');
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  private nextLooksFramed(): boolean {
    const head = this.peek(4);
    return head !== null && HEX4.test(head.toString('ascii'));
  }

  takeBuffered(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) {
        throw new Error(`truncated pkt-line: ${this.buffered} trailing byte(s)`);
      }
      return null;
    }
    const header = this.peek(4)!;
    if (!HEX4.test(header.toString('ascii'))) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header.toString('ascii'))}`);
    }
    const length = Number.parseInt(header.toString('ascii'), 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    }
    if (length > PKT_LINE_MAX) {
      throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    }
    if (this.buffered < length) {
      if (this.ended) {
        throw new Error(`truncated pkt-line: ${length} announced, ${this.buffered} available`);
      }
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  nextIsRaw(): boolean {
    if (this.buffered < 4) return false;
    return !this.nextLooksFramed();
  }
}

export function decodePktLines(bytes: Uint8Array, options: { allowTrailing?: boolean } = {}): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    if (options.allowTrailing && decoder.nextIsRaw()) break;
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  return packets;
}

// ============================================================================
// Packfile Reading/Writing
// ============================================================================

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4, ofsDelta: 6, refDelta: 7 };
const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = Buffer.from(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

export interface PackEntry {
  offset: number;
  type: string;
  size: number;
  data: Buffer;
  oid: string;
  delta: { kind: 'ofs' | 'ref'; baseOid: string } | null;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  entries: PackEntry[];
  trailer: string;
  computedTrailer: string;
  checksumOk: boolean;
  deltaCount: number;
  byteLength: number;
}

export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = packChecksum(pack);
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: string;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: string; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type as any, data: resolved.data, sha: resolved.oid });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
          ? { kind: 'ref', baseOid: entry.baseOid! }
          : null,
    });
  }

  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    computedTrailer,
    checksumOk,
    deltaCount,
    byteLength: pack.length,
  };
}

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Array<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = packChecksum(pack);
  return { ok: actual === expected, expected, actual };
}

// ============================================================================
// Reachability
// ============================================================================

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {}
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (root && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      // parse tag to get object
      const text = object.data.toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('object ')) {
          queue.push(line.slice(7));
          break;
        }
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.sha);
      }
    }
  }
  return seen;
}

// ============================================================================
// Git Smart HTTP Handlers
// ============================================================================

export interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export interface AdvertisementV0 {
  protocol: 0;
  service: string;
  refs: AdvertisedRef[];
  capabilities: Map<string, string>;
  headSymref: string | null;
}

export interface AdvertisementV2 {
  protocol: 2;
  service: string;
  capabilities: Map<string, string>;
}

export type Advertisement = AdvertisementV0 | AdvertisementV2;

export function parseAdvertisement(packets: GitPacket[], service: string): Advertisement {
  const lines: string[] = [];
  let hadServiceHeader = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (lines.length === 0 && !hadServiceHeader && text.startsWith('# service=')) {
      hadServiceHeader = true;
      continue;
    }
    lines.push(text);
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first === 'version 2' || first.startsWith('version 2 ')) {
    const capabilities = new Map<string, string>();
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (!text) continue;
      if (text === 'version 2') continue;
      const equals = text.indexOf('=');
      if (equals < 0) capabilities.set(text, '');
      else capabilities.set(text.slice(0, equals), text.slice(equals + 1));
    }
    return { protocol: 2, service, capabilities };
  }
  const refs: AdvertisedRef[] = [];
  const capabilities = new Map<string, string>();
  let headSymref: string | null = null;
  const rawRefs: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\n$/, '');
    if (!line) continue;
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const capText = line.slice(nul + 1);
        for (const token of capText.split(' ')) {
          if (!token) continue;
          const equals = token.indexOf('=');
          if (equals < 0) capabilities.set(token, '');
          else capabilities.set(token.slice(0, equals), token.slice(equals + 1));
        }
        line = line.slice(0, nul);
      }
    }
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (name.trim() === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -3);
      const existing = rawRefs.find((ref) => ref.name === base);
      if (existing) existing.peeled = oid;
      else rawRefs.push({ oid, name: base, peeled: oid });
      continue;
    }
    rawRefs.push({ oid, name });
  }
  for (const ref of rawRefs) {
    if (ref.oid === ZERO_OID) {
      refs.push({ oid: ref.oid, name: ref.name, unborn: true, peeled: ref.peeled });
      continue;
    }
    const entry: AdvertisedRef = { oid: ref.oid, name: ref.name, peeled: ref.peeled };
    if (ref.name === 'HEAD') {
      const symref = capabilities.get('symref');
      if (symref && symref.startsWith('HEAD:')) {
        entry.symrefTarget = symref.slice(5);
        headSymref = entry.symrefTarget;
      }
    }
    refs.push(entry);
  }
  return { protocol: 0, service, refs, capabilities, headSymref };
}

export function formatRefsAdvertisementV0(refs: Ref[], service: string, capabilities: Map<string, string>, headSymref: string | null): string {
  const caps = [...capabilities.entries()]
    .map(([key, value]) => (value ? `${key}=${value}` : key))
    .join(' ');
  const visible = refs.filter((ref) => ref.sha !== ZERO_OID);
  let body = '';
  if (visible.length === 0) {
    // Empty repository: the unborn-HEAD capability line carries a zero oid and the
    // "capabilities^{}" sentinel ref name.
    const symrefCap = headSymref ? ` symref=HEAD:${headSymref}` : '';
    const line = `${ZERO_OID} capabilities^{}\0${caps}${symrefCap}\n`;
    const len = (line.length + 4).toString(16).padStart(4, '0');
    body += `${len}${line}`;
    return `${body}0000`;
  }
  visible.forEach((ref, index) => {
    let line = `${ref.sha} ${ref.name}${headSymref && ref.name === headSymref ? ` symref=HEAD:${headSymref}` : ''}\n`;
    if (index === 0 && caps) line = `${ref.sha} ${ref.name}\0${caps}${headSymref && ref.name === headSymref ? ` symref=HEAD:${headSymref}` : ''}\n`;
    const len = (line.length + 4).toString(16).padStart(4, '0');
    body += `${len}${line}`;
  });
  return `${body}0000`;
}

export function formatRefsAdvertisementV2(capabilities: Map<string, string>): string {
  let body = 'version 2\n';
  for (const [key, value] of capabilities) {
    body += `${key}${value ? '=' + value : ''}\n`;
  }
  return body;
}

// ============================================================================
// Upload Pack (Fetch) - Protocol V2
// ============================================================================

export interface FetchRequestV2 {
  wants: string[];
  haves: string[];
  shallow?: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot?: string[];
  filter?: string;
  done?: boolean;
  haveObjects?: Map<string, GitObject>;
  thinPack?: boolean;
  noProgress?: boolean;
}

export interface FetchResultV2 {
  pack: Buffer | null;
  packBytes: number;
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  ready: boolean;
  wantedRefs: Array<{ oid: string; ref: string }>;
  progress: string;
  checksumOk: boolean;
  deltaCount: number;
}

export async function handleUploadPackV2(
  owner: string,
  repoName: string,
  request: FetchRequestV2
): Promise<FetchResultV2> {
  // This is a complex implementation. For now, return a minimal response.
  // In a full implementation, we would:
  // 1. Negotiate common objects (acks/nak)
  // 2. Generate a packfile with needed objects
  // 3. Apply shallow/deepen logic
  
  return {
    pack: null,
    packBytes: 0,
    objects: new Map(),
    shallow: [],
    unshallow: [],
    acks: [],
    nak: false,
    ready: false,
    wantedRefs: [],
    progress: '',
    checksumOk: true,
    deltaCount: 0,
  };
}

// ============================================================================
// Receive Pack (Push) - Protocol V0
// ============================================================================

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushRefReport {
  ref: string;
  ok: boolean;
  reason: string;
  options: Map<string, string>;
}

export interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: PushRefReport[];
}

export interface PushResult {
  report: PushReport | null;
  progress: string;
  sideband: boolean;
}

export function parsePushCommands(packets: GitPacket[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  return commands;
}

export function formatPushReport(report: PushReport): string {
  let body = `unpack ${report.unpackOk ? 'ok' : report.unpackDetail}\n`;
  for (const ref of report.refs) {
    if (ref.ok) {
      body += `ok ${ref.ref}\n`;
    } else {
      body += `ng ${ref.ref} ${ref.reason}\n`;
    }
    for (const [key, value] of ref.options) {
      body += `option ${key}${value ? ' ' + value : ''}\n`;
    }
  }
  return body;
}

export async function handleReceivePack(
  owner: string,
  repoName: string,
  commands: PushCommand[],
  packData: Buffer | null,
  haveObjects: Map<string, GitObject>
): Promise<PushResult> {
  // Validate commands
  const refs = storage.getRefs(owner, repoName);
  const refMap = new Map(refs.map(r => [r.name, r.sha]));
  
  const report: PushReport = {
    unpackOk: true,
    unpackDetail: 'ok',
    refs: [],
  };
  
  // If there's pack data, parse it and store objects
  if (packData && packData.length > 0) {
    try {
      const packResult = readPack(packData, {
        resolveBase: (oid) => haveObjects.get(oid),
      });
      if (!packResult.checksumOk) {
        report.unpackOk = false;
        report.unpackDetail = 'checksum mismatch';
      } else {
        // Store all objects from pack
        for (const [sha, obj] of packResult.objects) {
          if (!storage['gitObjects'].has(sha)) {
            storage['gitObjects'].set(sha, obj);
          }
        }
      }
    } catch (err) {
      report.unpackOk = false;
      report.unpackDetail = (err as Error).message;
    }
  }
  
  // Process each command
  for (const cmd of commands) {
    const currentSha = refMap.get(cmd.ref) || ZERO_OID;
    
    if (cmd.oldOid !== currentSha) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward', options: new Map() });
      continue;
    }
    
    if (cmd.newOid === ZERO_OID) {
      // Delete ref
      storage.deleteRef(owner, repoName, cmd.ref);
      report.refs.push({ ref: cmd.ref, ok: true, reason: '', options: new Map() });
    } else {
      // Update/create ref
      // Verify the newOid exists in our object store
      const obj = storage.getObject(cmd.newOid);
      if (!obj && !haveObjects.has(cmd.newOid)) {
        report.refs.push({ ref: cmd.ref, ok: false, reason: 'missing object', options: new Map() });
        continue;
      }
      storage.setRef(owner, repoName, cmd.ref, cmd.newOid);
      refMap.set(cmd.ref, cmd.newOid);
      report.refs.push({ ref: cmd.ref, ok: true, reason: '', options: new Map() });
    }
  }
  
  return {
    report,
    progress: '',
    sideband: false,
  };
}

// ============================================================================
// Storage extensions for git objects
// ============================================================================

// Add git object storage to the storage instance
declare module './storage.ts' {
  interface Storage {
    gitObjects: Map<string, GitObject>;
    getObject(sha: string): GitObject | null;
    hasObject(sha: string): boolean;
    storeObject(type: string, data: Buffer): string;
    createBlob(content: Buffer): string;
    createTree(entries: TreeEntry[]): string;
    createCommit(commit: CommitData): string;
    parseCommit(data: Buffer): CommitData;
    parseTree(data: Buffer): TreeEntry[];
  }
}

// Extend storage with git object methods
const originalStorage = storage as any;
if (!originalStorage.gitObjects) {
  originalStorage.gitObjects = new Map<string, GitObject>();
  
  originalStorage.getObject = function(sha: string): GitObject | null {
    return this.gitObjects.get(sha) || null;
  };
  
  originalStorage.hasObject = function(sha: string): boolean {
    return this.gitObjects.has(sha);
  };
  
  originalStorage.storeObject = function(type: string, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.gitObjects.has(sha)) {
      this.gitObjects.set(sha, { type: type as any, data, sha });
    }
    return sha;
  };
  
  originalStorage.createBlob = function(content: Buffer): string {
    return this.storeObject('blob', content);
  };
  
  originalStorage.createTree = function(entries: TreeEntry[]): string {
    const data = buildTree(entries);
    return this.storeObject('tree', data);
  };
  
  originalStorage.createCommit = function(commit: CommitData): string {
    const data = buildCommit(commit);
    return this.storeObject('commit', data);
  };
  
  originalStorage.parseCommit = parseCommit;
  originalStorage.parseTree = parseTree;
}
export const ZERO_OID = '0'.repeat(40);
