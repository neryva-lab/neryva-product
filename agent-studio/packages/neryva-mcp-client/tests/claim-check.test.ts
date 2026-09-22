/**
 * claim-check.test.ts — ArtifactRef validation
 * Source: ledger.md:2.6, neryva_mcp_implementation_plan.md:595
 */

import { describe, it, expect } from 'vitest';
import { validateArtifactRef, shouldUseClaimCheck } from '../src/claim-check.js';

describe('claim-check', () => {
  const base = {
    artifactId: 'art_123',
    organizationId: 'org_A',
    runId: 'run_1',
    purpose: 'TOOL_RESULT' as const,
    mediaType: 'application/json',
    byteLength: 1024,
    sha256: new Uint8Array(32),
    expiresAt: new Date(Date.now() + 3600_000),
  };

  it('valid ref passes', () => {
    expect(() => validateArtifactRef(base)).not.toThrow();
  });

  it('sha256 must be 32B', () => {
    expect(() => validateArtifactRef({ ...base, sha256: new Uint8Array(16) })).toThrow(/32B/);
  });

  it('purpose must be allowlisted', () => {
    expect(() => validateArtifactRef({ ...base, purpose: 'invalid' as never })).toThrow(
      /allowlisted/,
    );
  });

  it('expired ref rejected', () => {
    expect(() => validateArtifactRef({ ...base, expiresAt: new Date(Date.now() - 1000) })).toThrow(
      /expired/,
    );
  });

  it('shouldUseClaimCheck respects threshold', () => {
    expect(shouldUseClaimCheck(100, 8192)).toBe(false);
    expect(shouldUseClaimCheck(9000, 8192)).toBe(true);
    expect(shouldUseClaimCheck(100, 8192, 'sensitive')).toBe(true);
  });
});
