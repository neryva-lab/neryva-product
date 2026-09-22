/**
 * checksums.ts — sha256 handling for artifact refs
 * Source: agent_studio_implementation_plan.md:341-352 (sha256==32B at boundary), 585-596
 * Uses Node crypto where available; fallback to pure validation in tests.
 */
import { createHash } from 'node:crypto';

export function computeSha256(data: Uint8Array): Uint8Array {
  const hash = createHash('sha256').update(data).digest();
  return new Uint8Array(hash);
}

export function computeSha256Hex(data: Uint8Array): string {
  return toHex(computeSha256(data));
}

export function toHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('toHex requires Uint8Array');
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new Error('fromHex requires string');
  if (!/^[a-f0-9]{64}$/.test(hex))
    throw new Error(`sha256 hex must be 64 lower hex chars, got ${hex.length}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function validateSha256Bytes(sha256: Uint8Array): void {
  if (!(sha256 instanceof Uint8Array) || sha256.length !== 32) {
    throw new Error(
      `sha256 must be 32B, got ${sha256 instanceof Uint8Array ? sha256.length : String(sha256)}`,
    );
  }
}

export function validateSha256Hex(hex: string): void {
  if (!/^[a-f0-9]{64}$/.test(hex))
    throw new Error(`sha256 hex must be 64 lower hex chars, got ${hex}`);
}

export function verifyChecksum(data: Uint8Array, expectedSha256: Uint8Array): void {
  validateSha256Bytes(expectedSha256);
  const actual = computeSha256(data);
  if (!equalBytes(actual, expectedSha256)) {
    const exp = toHex(expectedSha256);
    const act = toHex(actual);
    throw new Error(`checksum mismatch expected ${exp} got ${act}`);
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
