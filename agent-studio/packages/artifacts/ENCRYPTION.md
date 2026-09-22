# Encryption — artifact envelope encryption

`@neryva/artifacts` ships **real** authenticated envelope encryption for artifact
payloads. The previous Phase 7 stub (plaintext returned as "ciphertext",
deterministic IV, no authentication tag) is gone — see `src/encryption.ts`.

## Algorithm

- **AES-256-GCM** via `node:crypto` (`createCipheriv` / `createDecipheriv`).
- **Random 96-bit IV per encryption.** A fresh `crypto.randomBytes(12)` IV is
  generated for every `envelopeEncrypt` call — the IV is never reused with the
  same key by construction (birthday bound: ~2^48 encryptions per key before a
  repeat is plausible; keys are rotated long before that).
- **128-bit authentication tag.** Decrypt verifies the tag and fails hard on
  any tampering (bit-flip in ciphertext, bit-flip in tag, wrong key). No
  partial plaintext is ever returned, and the failure message is a generic
  `envelope: authentication failed` — it never distinguishes tampering from a
  wrong key and never includes plaintext.

## Envelope format (`EnvelopeEncrypted`)

```ts
{
  version: 1,                    // envelope format version
  algorithm: 'aes-256-gcm',
  keyId: string,                 // KMS key reference, never raw key material
  purpose: string,               // bound cryptographically (see below)
  iv: Uint8Array,                // exactly 12 bytes
  tag: Uint8Array,               // exactly 16 bytes
  ciphertext: Uint8Array,
}
```

**Key-ID + purpose binding.** `keyId` and `purpose` are part of the GCM
additional authenticated data (AAD), length-prefixed so there is no separator
ambiguity. Decrypt additionally refuses — before touching crypto — when the
caller's requested `keyId`/`purpose` differs from the envelope's. There is no
cross-key and no cross-purpose decryption.

## Key-management responsibilities (explicit boundary)

This module is a **crypto primitive, not a key manager**:

- The ONLY way this module obtains key material is the `KeyProvider` interface:
  `getKey(keyId): Promise<Uint8Array>` returning the raw 32-byte AES-256 key.
- The module **never hardcodes keys, never reads `process.env` (or any other
  secret source)**. A static check in `tests/encryption.test.ts` asserts the
  source contains no `process.env`/`getenv`/`dotenv` outside comments.
- In production the `KeyProvider` is implemented by the deployment's
  **KMS/HSM integration via the secret-provider**. The provider owns its key
  buffers; the module copies what it needs and never mutates provider buffers.
- `keyId` values are validated (`^[a-zA-Z0-9_-]{1,64}$`) before the provider is
  called; key material is validated to be exactly 32 bytes after it is returned.
  Error messages never carry key material.

## Rotation story

1. Provision the new key in the KMS under a new `keyId` (e.g.
   `artifacts-2026-q3` → `artifacts-2026-q4`).
2. Point new encryptions at the new `keyId` (`EncryptionOptions.keyId`).
3. Keep the old `keyId` resolvable in the provider for reads: `envelopeDecrypt`
   reads the envelope's own `keyId`, so old artifacts keep decrypting as long
   as the provider still serves the retired key.
4. Re-encrypt or expire old artifacts per `retention.ts` policy, then retire
   the old KMS key. No code change in this module is needed at any step.

## No plaintext leakage

- Encryption works on an internal copy of the plaintext; the working buffer is
  zeroed in a `finally` block. The caller's buffer is never retained.
- Decrypt copies the plaintext out, zeroes the internal buffer, then returns
  the copy.
- All error paths throw without plaintext content.

## What this module does NOT do (deliberate non-goals)

- **No KMS.** It does not provision, store, rotate, or fetch keys on its own —
  that is the deployment's KMS/HSM behind `KeyProvider`.
- **No envelope (DEK/KEK) layering.** The artifact payload is encrypted directly
  with the KMS-resolved key. If a deployment needs per-artifact data keys,
  that belongs in the KMS adapter, not here.
- **No at-rest storage.** This module encrypts bytes; where the envelope is
  persisted (object store, claim-check ref) is the caller's concern.
- **No access control.** `purpose` binding is a cryptographic guard, not an
  authorization check — artifact reads must still be re-authorized fresh per
  the Studio security model.
- **No streaming.** Payloads are encrypted as whole buffers; large artifacts
  should stay behind claim-check refs.
