/**
 * encryption.ts — envelope encryption for artifact payloads
 * Source: agent_studio_implementation_plan.md:839-848 (encrypted Temporal payload codec where needed, classification/key source/rotation),
 * 325-340 (encryption_key_ref), docs/toolchain.md (KMS/manual)
 * Studio never holds raw provider secrets; artifacts encrypted via KMS envelope where required.
 * This module provides key-reference validation and encrypt/decrypt stubs that delegate to KMS via secret-provider.
 */

export interface EncryptionOptions {
  keyId: string; // KMS key reference, never raw key
  purpose: string;
}

const VALID_KEY_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateEncryptionKeyId(keyId: string): void {
  if (!VALID_KEY_ID.test(keyId))
    throw new Error(`encryption_key_id must match ${String(VALID_KEY_ID)}, got ${keyId}`);
}

export function validateEncryptionOptions(opts: EncryptionOptions): void {
  if (!opts.keyId) throw new Error('encryption keyId required');
  validateEncryptionKeyId(opts.keyId);
  if (!opts.purpose) throw new Error('encryption purpose required');
}

export interface EnvelopeEncrypted {
  ciphertext: Uint8Array;
  keyId: string;
  iv: Uint8Array; // 12B for AES-GCM
  tag?: Uint8Array;
}

/**
 * Stub encrypt — in production, calls KMS envelope encrypt.
 * For tests, does deterministic XOR-like transform but preserves API shape.
 * Must be replaced with real KMS adapter behind secret-provider; tests prove redaction, not crypto strength.
 */
export async function envelopeEncrypt(
  plaintext: Uint8Array,
  opts: EncryptionOptions,
): Promise<EnvelopeEncrypted> {
  validateEncryptionOptions(opts);
  // For Phase 7, we do not implement real crypto; we simulate envelope by tagging.
  // Real implementation: generate DEK via KMS, encrypt plaintext with DEK, encrypt DEK with KMS.
  // Here: return plaintext as ciphertext with metadata to prove plumbing.
  const iv = new Uint8Array(12);
  // fill iv deterministically from keyId hash for test reproducibility
  for (let i = 0; i < 12; i++) iv[i] = opts.keyId.charCodeAt(i % opts.keyId.length) % 256;
  return { ciphertext: plaintext, keyId: opts.keyId, iv };
}

export async function envelopeDecrypt(encrypted: EnvelopeEncrypted): Promise<Uint8Array> {
  if (!encrypted.keyId) throw new Error('decrypt requires keyId');
  validateEncryptionKeyId(encrypted.keyId);
  // Stub: return ciphertext as plaintext (symmetric stub)
  return encrypted.ciphertext;
}

export function isEncryptedRef(artifact: { encryptionKeyId?: string }): boolean {
  return Boolean(
    artifact.encryptionKeyId &&
    artifact.encryptionKeyId !== 'kms-default' &&
    artifact.encryptionKeyId !== '',
  );
}
