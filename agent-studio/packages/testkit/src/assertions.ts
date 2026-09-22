/**
 * assertions.ts — test helpers for Studio invariants
 */

export function assertTenantScope(actualOrgId: string, expectedOrgId: string): void {
  if (actualOrgId !== expectedOrgId) {
    throw new Error(`tenant scope mismatch: expected ${expectedOrgId}, got ${actualOrgId}`);
  }
}

export function assertNoSecretsInString(value: string): void {
  const forbidden = [/sk-[a-zA-Z0-9]{20,}/, /Bearer\s+[a-zA-Z0-9._-]+/, /api_key/i];
  for (const re of forbidden) {
    if (re.test(value)) {
      throw new Error(`secret leakage detected: ${re}`);
    }
  }
}

export function assertArtifactRef(ref: { sha256: Uint8Array; purpose: string }): void {
  if (ref.sha256.length !== 32) throw new Error(`sha256 must be 32B, got ${ref.sha256.length}`);
  if (!ref.purpose) throw new Error('purpose enum required');
}
