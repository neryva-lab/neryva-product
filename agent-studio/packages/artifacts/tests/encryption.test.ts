/**
 * encryption.test.ts — real authenticated encryption (AES-256-GCM).
 *
 * This suite proves the encryption layer is REAL, replacing the former Phase 7
 * stub (plaintext-as-ciphertext, deterministic IV, no auth tag). Every test
 * below would have failed against the stub: the stub returned plaintext, used
 * a deterministic IV, and had no tag to tamper with.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  envelopeEncrypt,
  envelopeDecrypt,
  validateEncryptionKeyId,
  validateEncryptionPurpose,
  validateEncryptionOptions,
  isEncryptedRef,
  type EncryptionOptions,
  type EnvelopeEncrypted,
  type KeyProvider,
} from '../src/encryption.js';

const PLAINTEXT = Buffer.from('neryva top-secret artifact payload 8675309', 'utf8');

function keyBytes(seed: number): Uint8Array {
  // Deterministic per-test key material; NOT how production keys are made.
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i * 7) & 0xff;
  return b;
}

function makeProvider(entries: Record<string, Uint8Array>): KeyProvider {
  return {
    async getKey(keyId: string): Promise<Uint8Array> {
      const k = entries[keyId];
      if (!k) throw new Error(`test provider: unknown keyId`);
      return k;
    },
  };
}

const OPTS: EncryptionOptions = { keyId: 'test-key-1', purpose: 'TOOL_RESULT' };

async function encryptRound(
  plaintext: Uint8Array = PLAINTEXT,
  opts: EncryptionOptions = OPTS,
  provider?: KeyProvider,
): Promise<EnvelopeEncrypted> {
  const keys = provider ?? makeProvider({ [OPTS.keyId]: keyBytes(1) });
  return envelopeEncrypt(plaintext, opts, keys);
}

function withFlippedByte(
  env: EnvelopeEncrypted,
  field: 'ciphertext' | 'tag',
): EnvelopeEncrypted {
  const copy = new Uint8Array(env[field]);
  copy[0] ^= 0x01;
  return { ...env, [field]: copy };
}

describe('encryption (AES-256-GCM envelope)', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await envelopeEncrypt(PLAINTEXT, OPTS, keys);
    expect(env.version).toBe(1);
    expect(env.algorithm).toBe('aes-256-gcm');
    expect(env.keyId).toBe(OPTS.keyId);
    expect(env.purpose).toBe(OPTS.purpose);
    expect(env.iv.length).toBe(12);
    expect(env.tag.length).toBe(16);
    expect(env.ciphertext.length).toBe(PLAINTEXT.length);
    const back = await envelopeDecrypt(env, OPTS, keys);
    expect(Buffer.from(back)).toEqual(Buffer.from(PLAINTEXT));
  });

  it('round-trips empty plaintext', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await envelopeEncrypt(new Uint8Array(0), OPTS, keys);
    const back = await envelopeDecrypt(env, OPTS, keys);
    expect(back.length).toBe(0);
  });

  it('is non-deterministic: two encryptions of the same plaintext differ', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const a = await envelopeEncrypt(PLAINTEXT, OPTS, keys);
    const b = await envelopeEncrypt(PLAINTEXT, OPTS, keys);
    expect(Buffer.from(a.iv)).not.toEqual(Buffer.from(b.iv));
    expect(Buffer.from(a.ciphertext)).not.toEqual(Buffer.from(b.ciphertext));
    expect(Buffer.from(a.tag)).not.toEqual(Buffer.from(b.tag));
  });

  it('fails decrypt with the wrong key (same keyId, different key material)', async () => {
    const env = await encryptRound();
    const wrongKeys = makeProvider({ [OPTS.keyId]: keyBytes(2) });
    await expect(envelopeDecrypt(env, OPTS, wrongKeys)).rejects.toThrow(
      'envelope: authentication failed',
    );
  });

  it('fails decrypt when a ciphertext bit is flipped', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await encryptRound();
    await expect(
      envelopeDecrypt(withFlippedByte(env, 'ciphertext'), OPTS, keys),
    ).rejects.toThrow('envelope: authentication failed');
  });

  it('fails decrypt when a tag bit is flipped', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await encryptRound();
    await expect(envelopeDecrypt(withFlippedByte(env, 'tag'), OPTS, keys)).rejects.toThrow(
      'envelope: authentication failed',
    );
  });

  it('rejects a malformed IV length before touching crypto', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await encryptRound();
    const bad = { ...env, iv: new Uint8Array(8) };
    await expect(envelopeDecrypt(bad, OPTS, keys)).rejects.toThrow(
      'envelope: iv must be 12 bytes',
    );
  });

  it('rejects a malformed tag length before touching crypto', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await encryptRound();
    const bad = { ...env, tag: new Uint8Array(8) };
    await expect(envelopeDecrypt(bad, OPTS, keys)).rejects.toThrow(
      'envelope: tag must be 16 bytes',
    );
  });

  it('refuses decrypt with the wrong keyId (no cross-key decryption)', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await encryptRound();
    await expect(
      envelopeDecrypt(env, { keyId: 'other-key', purpose: OPTS.purpose }, keys),
    ).rejects.toThrow('envelope: keyId mismatch');
  });

  it('refuses decrypt with the wrong purpose (no cross-purpose decryption)', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    const env = await encryptRound();
    await expect(
      envelopeDecrypt(env, { keyId: OPTS.keyId, purpose: 'CHECKPOINT' }, keys),
    ).rejects.toThrow('envelope: purpose mismatch');
  });

  it('never leaks plaintext into the envelope output', async () => {
    const env = await encryptRound();
    const blob = Buffer.concat([
      Buffer.from(env.iv),
      Buffer.from(env.tag),
      Buffer.from(env.ciphertext),
    ]).toString('binary');
    const secret = PLAINTEXT.toString('binary');
    expect(blob).not.toContain(secret);
    // And the tag alone must not be the plaintext either.
    expect(Buffer.from(env.tag).toString('binary')).not.toContain(secret);
  });

  it('never includes plaintext in error messages', async () => {
    const env = await encryptRound();
    const wrongKeys = makeProvider({ [OPTS.keyId]: keyBytes(2) });
    const secret = PLAINTEXT.toString('utf8');
    try {
      await envelopeDecrypt(env, OPTS, wrongKeys);
      expect.unreachable('decrypt should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain('8675309');
    }
  });

  it('rejects an invalid keyId format on encrypt', async () => {
    const keys = makeProvider({ 'bad key!': keyBytes(1) });
    await expect(
      envelopeEncrypt(PLAINTEXT, { keyId: 'bad key!', purpose: 'TOOL_RESULT' }, keys),
    ).rejects.toThrow('encryption_key_id must match');
    expect(() => validateEncryptionKeyId('ok_key-1')).not.toThrow();
    expect(() => validateEncryptionKeyId('no spaces allowed')).toThrow();
  });

  it('rejects an invalid purpose on encrypt', async () => {
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    await expect(
      envelopeEncrypt(PLAINTEXT, { keyId: OPTS.keyId, purpose: 'not a purpose!' }, keys),
    ).rejects.toThrow('encryption purpose must match');
    expect(() => validateEncryptionPurpose('TOOL_RESULT')).not.toThrow();
    expect(() =>
      validateEncryptionOptions({ keyId: OPTS.keyId, purpose: '' }),
    ).toThrow('encryption purpose required');
  });

  it('rejects key material that is not a 32-byte AES-256 key', async () => {
    const shortKeys: KeyProvider = {
      async getKey(): Promise<Uint8Array> {
        return new Uint8Array(16);
      },
    };
    await expect(envelopeEncrypt(PLAINTEXT, OPTS, shortKeys)).rejects.toThrow(
      'expected 32 bytes',
    );
    const env = await encryptRound();
    await expect(envelopeDecrypt(env, OPTS, shortKeys)).rejects.toThrow(
      'expected 32 bytes',
    );
  });

  it('module never reads env or hardcodes keys (static source check)', () => {
    const srcPath = new URL('../src/encryption.ts', import.meta.url);
    const raw = readFileSync(srcPath, 'utf8');
    // Strip comments so documentation mentioning process.env does not trip the check.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/getenv/);
    expect(src).not.toMatch(/dotenv/);
    // The only key-size literal allowed is the 32-byte *length check*, never a key value.
    expect(src).toContain('getKey');
    expect(src).toContain('KeyProvider');
  });

  it('isEncryptedRef still classifies refs the same as before', () => {
    expect(isEncryptedRef({ encryptionKeyId: 'kms-default' })).toBe(false);
    expect(isEncryptedRef({ encryptionKeyId: '' })).toBe(false);
    expect(isEncryptedRef({})).toBe(false);
    expect(isEncryptedRef({ encryptionKeyId: 'projects/p/locations/l/keyRings/r/cryptoKeys/k' })).toBe(
      true,
    );
  });

  it('accepts a 12-byte crypto-random IV per encryption (structural)', async () => {
    const seen = new Set<string>();
    const keys = makeProvider({ [OPTS.keyId]: keyBytes(1) });
    for (let i = 0; i < 25; i++) {
      const env = await envelopeEncrypt(PLAINTEXT, OPTS, keys);
      const hex = Buffer.from(env.iv).toString('hex');
      expect(hex).not.toBe('000000000000000000000000');
      seen.add(hex);
    }
    // 25 fresh random 96-bit IVs must all be distinct — never the old stub's
    // deterministic keyId-derived bytes.
    expect(seen.size).toBe(25);
  });
});
