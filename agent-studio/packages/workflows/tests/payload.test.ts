/**
 * payload.test.ts — Temporal payload protection
 * Source: agent_studio_implementation_plan.md:839-848, agent_studio_architecture.md:133-143, 558-598
 */

import { describe, it, expect } from 'vitest';
import {
  validatePayloadSize,
  assertNoForbiddenContent,
  isValidClaimCheckRef,
  MAX_INLINE_BYTES,
} from '../src/payload.js';

describe('payload protection', () => {
  it('small payload passes and requires no claim-check', () => {
    const meta = validatePayloadSize({ a: 'hello' }, 'INTERNAL');
    expect(meta.requiresClaimCheck).toBe(false);
    expect(meta.byteLength).toBeGreaterThan(0);
  });

  it('large payload requires claim-check', () => {
    const big = { text: 'x'.repeat(MAX_INLINE_BYTES + 1) };
    const meta = validatePayloadSize(big, 'INTERNAL');
    expect(meta.requiresClaimCheck).toBe(true);
    expect(meta.reason).toContain('MAX_INLINE_BYTES');
  });

  it('SENSITIVE always requires claim-check even if small', () => {
    const meta = validatePayloadSize({ token: 'abc' }, 'SENSITIVE');
    expect(meta.requiresClaimCheck).toBe(true);
  });

  it('forbidden content pattern is detected', () => {
    const hit = 'sk-proj-abcdef1234567890abcdef1234567890';
    expect(() => assertNoForbiddenContent(hit)).toThrow(/forbidden content/);
  });

  it('clean payload passes forbidden check', () => {
    expect(() => assertNoForbiddenContent({ text: 'hello world' })).not.toThrow();
  });

  it('claim-check ref validates sha256 64 chars and allowlisted purpose', () => {
    const ref = {
      artifactId: 'art_123',
      organizationId: 'org_1',
      runId: 'run_1',
      purpose: 'TOOL_RESULT',
      byteLength: 100,
      sha256: 'a'.repeat(64),
      expiresAt: new Date().toISOString(),
    };
    expect(isValidClaimCheckRef(ref)).toBe(true);
    const bad = { ...ref, sha256: 'abc' };
    expect(isValidClaimCheckRef(bad)).toBe(false);
  });
});
