import { describe, it, expect } from 'vitest';
import {
  computeSha256,
  toHex,
  fromHex,
  verifyChecksum,
  validateSha256Bytes,
  equalBytes,
} from '../src/checksums.js';

describe('checksums (341-352 sha256==32B at boundary)', () => {
  it('computeSha256 returns 32B for known input', () => {
    const data = new TextEncoder().encode('hello');
    const hash = computeSha256(data);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
    // known sha256 of "hello"
    const hex = toHex(hash);
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
  it('toHex/fromHex round-trip 32B', () => {
    const data = new TextEncoder().encode('artifact content for test');
    const hash = computeSha256(data);
    const hex = toHex(hash);
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
    const back = fromHex(hex);
    expect(equalBytes(hash, back)).toBe(true);
  });
  it('validateSha256Bytes rejects wrong length', () => {
    expect(() => validateSha256Bytes(new Uint8Array(31))).toThrow(/32B/);
    expect(() => validateSha256Bytes(new Uint8Array(33))).toThrow(/32B/);
    expect(() => validateSha256Bytes(new Uint8Array(32))).not.toThrow();
  });
  it('fromHex rejects invalid hex', () => {
    expect(() => fromHex('zzzz')).toThrow(/64 lower hex/);
    expect(() => fromHex('a'.repeat(63))).toThrow();
    expect(() => fromHex('A'.repeat(64))).toThrow(); // must be lower
  });
  it('verifyChecksum succeeds on matching', () => {
    const content = new TextEncoder().encode('long tool result that will be artifact');
    const sha = computeSha256(content);
    expect(() => verifyChecksum(content, sha)).not.toThrow();
  });
  it('verifyChecksum throws on tampered content', () => {
    const content = new TextEncoder().encode('original');
    const sha = computeSha256(content);
    const tampered = new TextEncoder().encode('tampered');
    expect(() => verifyChecksum(tampered, sha)).toThrow(/checksum mismatch/);
  });
  it('sha256 hex length 64 enforces 32B boundary at artifact ref creation', () => {
    const hex = 'a'.repeat(64);
    const bytes = fromHex(hex);
    expect(bytes.length).toBe(32);
    expect(toHex(bytes).length).toBe(64);
  });
});
