/**
 * encryption.ts — real authenticated envelope encryption for artifact payloads.
 *
 * Algorithm: AES-256-GCM via node:crypto.
 * - Random 96-bit IV per encryption (never reused with the same key by construction:
 *   a fresh crypto-random IV is generated for every envelopeEncrypt call).
 * - 128-bit authentication tag; decrypt verifies the tag and fails hard on any
 *   tampering — no partial plaintext is ever returned.
 * - keyId + purpose are bound cryptographically as GCM additional authenticated
 *   data (AAD); decrypt refuses a wrong keyId or wrong purpose before decryption.
 *
 * KEY MANAGEMENT (explicit boundary):
 * - This module NEVER hardcodes keys and NEVER reads process.env (or any other
 *   secret source) directly. All key material arrives through the KeyProvider
 *   interface supplied by the caller.
 * - In production the KeyProvider is implemented by the deployment's KMS/HSM
 *   integration (via the secret-provider); see ENCRYPTION.md for the rotation
 *   story and for what this module deliberately does NOT do.
 *
 * Historical note: this module used to ship a Phase 7 stub that returned
 * plaintext as "ciphertext" with a deterministic IV. That stub is gone; the
 * envelope format below is the real one.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export interface EncryptionOptions {
  keyId: string; // KMS key reference, never raw key
  purpose: string;
}

/**
 * KeyProvider — the ONLY way this module obtains key material.
 *
 * Implementations resolve a validated keyId to the raw 32-byte AES-256 key.
 * Production implementations MUST be backed by the deployment's KMS/HSM
 * (via the secret-provider); they MUST NOT embed keys in source, config, or
 * environment variables. The provider owns the returned buffer — this module
 * copies what it needs and never mutates or retains provider buffers.
 */
export interface KeyProvider {
  /** Resolve the raw 32-byte AES-256 key for a keyId that has passed keyId validation. */
  getKey(keyId: string): Promise<Uint8Array>;
}

export const ENVELOPE_VERSION = 1 as const;
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm' as const;

/** Encrypted envelope. All fields are required; there is no "stub mode". */
export interface EnvelopeEncrypted {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  purpose: string;
  iv: Uint8Array; // exactly 12 bytes (96-bit), random per encryption
  tag: Uint8Array; // exactly 16 bytes (128-bit GCM auth tag)
  ciphertext: Uint8Array;
}

const VALID_KEY_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_PURPOSE = /^[a-zA-Z0-9_.-]{1,64}$/;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;

export function validateEncryptionKeyId(keyId: string): void {
  if (!VALID_KEY_ID.test(keyId))
    throw new Error(`encryption_key_id must match ${String(VALID_KEY_ID)}, got ${keyId}`);
}

export function validateEncryptionPurpose(purpose: string): void {
  if (!VALID_PURPOSE.test(purpose))
    throw new Error(`encryption purpose must match ${String(VALID_PURPOSE)}, got ${purpose}`);
}

export function validateEncryptionOptions(opts: EncryptionOptions): void {
  if (!opts.keyId) throw new Error('encryption keyId required');
  validateEncryptionKeyId(opts.keyId);
  if (!opts.purpose) throw new Error('encryption purpose required');
  validateEncryptionPurpose(opts.purpose);
}

function validateKeyBytes(key: Uint8Array): void {
  // Message intentionally contains no key material — only lengths.
  if (!(key instanceof Uint8Array) || key.length !== AES_256_KEY_BYTES)
    throw new Error(
      `encryption key failed validation: expected ${AES_256_KEY_BYTES} bytes`,
    );
}

function validateEnvelopeShape(envelope: unknown): asserts envelope is EnvelopeEncrypted {
  if (typeof envelope !== 'object' || envelope === null)
    throw new Error('envelope: not an object');
  const e = envelope as {
    version?: unknown;
    algorithm?: unknown;
    keyId?: unknown;
    purpose?: unknown;
    iv?: unknown;
    tag?: unknown;
    ciphertext?: unknown;
  };
  if (e.version !== ENVELOPE_VERSION) throw new Error(`envelope: unsupported version`);
  if (e.algorithm !== ENCRYPTION_ALGORITHM) throw new Error(`envelope: unsupported algorithm`);
  if (typeof e.keyId !== 'string' || e.keyId.length === 0)
    throw new Error('decrypt requires keyId');
  validateEncryptionKeyId(e.keyId);
  if (typeof e.purpose !== 'string' || e.purpose.length === 0)
    throw new Error('decrypt requires purpose');
  validateEncryptionPurpose(e.purpose);
  if (!(e.iv instanceof Uint8Array) || e.iv.length !== GCM_IV_BYTES)
    throw new Error(`envelope: iv must be ${GCM_IV_BYTES} bytes`);
  if (!(e.tag instanceof Uint8Array) || e.tag.length !== GCM_TAG_BYTES)
    throw new Error(`envelope: tag must be ${GCM_TAG_BYTES} bytes`);
  if (!(e.ciphertext instanceof Uint8Array))
    throw new Error('envelope: ciphertext must be bytes');
}

/**
 * Bind version, algorithm, keyId, purpose as GCM additional authenticated data.
 * Length-prefixed so there is no separator ambiguity, and so a wrong
 * keyId/purpose fails tag verification even if the caller-side checks were
 * somehow bypassed.
 */
function buildAad(keyId: string, purpose: string): Buffer {
  const parts = [String(ENVELOPE_VERSION), ENCRYPTION_ALGORITHM, keyId, purpose];
  const bufs: Buffer[] = [Buffer.from('neryva-envelope/v1', 'utf8')];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    bufs.push(len, bytes);
  }
  return Buffer.concat(bufs);
}

function zeroBytes(buf: Uint8Array): void {
  buf.fill(0);
}

export async function envelopeEncrypt(
  plaintext: Uint8Array,
  opts: EncryptionOptions,
  keys: KeyProvider,
): Promise<EnvelopeEncrypted> {
  validateEncryptionOptions(opts);
  const key = await keys.getKey(opts.keyId);
  validateKeyBytes(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const aad = buildAad(opts.keyId, opts.purpose);
  // Work on an internal copy so the working plaintext can be zeroed on the way
  // out; the caller's buffer is never retained.
  const workingPlain = Buffer.from(plaintext);
  try {
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, Buffer.from(key), iv, {
      authTagLength: GCM_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(workingPlain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: ENVELOPE_VERSION,
      algorithm: ENCRYPTION_ALGORITHM,
      keyId: opts.keyId,
      purpose: opts.purpose,
      iv: Uint8Array.from(iv),
      tag: Uint8Array.from(tag),
      ciphertext: Uint8Array.from(ciphertext),
    };
  } finally {
    zeroBytes(workingPlain);
  }
}

export async function envelopeDecrypt(
  envelope: EnvelopeEncrypted,
  opts: EncryptionOptions,
  keys: KeyProvider,
): Promise<Uint8Array> {
  validateEncryptionOptions(opts);
  validateEnvelopeShape(envelope);
  // Key-ID + purpose binding: refuse cross-key / cross-purpose decryption.
  if (envelope.keyId !== opts.keyId)
    throw new Error('envelope: keyId mismatch — refusing decrypt');
  if (envelope.purpose !== opts.purpose)
    throw new Error('envelope: purpose mismatch — refusing decrypt');
  const key = await keys.getKey(opts.keyId);
  validateKeyBytes(key);
  const aad = buildAad(envelope.keyId, envelope.purpose);
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      Buffer.from(key),
      Buffer.from(envelope.iv),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext)),
      decipher.final(),
    ]);
    const out = Uint8Array.from(plain);
    zeroBytes(plain);
    return out;
  } catch {
    // Deliberately generic: authentication failure, tampered ciphertext/tag,
    // or wrong key all surface identically, and the message never carries
    // plaintext. No partial plaintext is returned on any path.
    throw new Error('envelope: authentication failed');
  }
}

export function isEncryptedRef(artifact: { encryptionKeyId?: string }): boolean {
  return Boolean(
    artifact.encryptionKeyId &&
    artifact.encryptionKeyId !== 'kms-default' &&
    artifact.encryptionKeyId !== '',
  );
}
