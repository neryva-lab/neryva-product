import { describe, it, expect } from 'vitest';
import {
  createSizePolicy,
  shouldClaimCheck,
  validateInlineSize,
  validateArtifactSize,
  validateWorkflowArgSize,
  DEFAULT_MAX_INLINE_BYTES,
  DEFAULT_MAX_ARTIFACT_BYTES,
} from '../src/size-policy.js';

describe('size-policy (1484 large data never in workflow args; 341-352 oversize)', () => {
  it('shouldClaimCheck true when byteLength > maxInlineBytes', () => {
    const p = createSizePolicy({ maxInlineBytes: 8192 });
    expect(shouldClaimCheck(8193, 'standard', p)).toBe(true);
    expect(shouldClaimCheck(8192, 'standard', p)).toBe(false);
  });
  it('shouldClaimCheck true for sensitive classification regardless of size', () => {
    const p = createSizePolicy({ maxInlineBytes: 8192 });
    expect(shouldClaimCheck(100, 'SENSITIVE', p)).toBe(true);
    expect(shouldClaimCheck(100, 'RESTRICTED', p)).toBe(true);
    expect(shouldClaimCheck(100, 'CONFIDENTIAL', p)).toBe(true);
  });
  it('validateInlineSize rejects oversized', () => {
    const p = createSizePolicy({ maxInlineBytes: 8192 });
    expect(() => validateInlineSize(8193, p)).toThrow(/exceeds maxInlineBytes/);
    expect(() => validateInlineSize(8192, p)).not.toThrow();
  });
  it('validateArtifactSize rejects > maxArtifactBytes', () => {
    const p = createSizePolicy({ maxArtifactBytes: 10_485_760 });
    expect(() => validateArtifactSize(10_485_761, p)).toThrow(/exceeds maxArtifactBytes/);
    expect(() => validateArtifactSize(10_485_760, p)).not.toThrow();
  });
  it('validateWorkflowArgSize mirrors inline and errors with claim-check hint', () => {
    const p = createSizePolicy({ maxInlineBytes: 8192 });
    expect(() => validateWorkflowArgSize(9000, p)).toThrow(/must use claim-check ArtifactRef/);
    expect(() => validateWorkflowArgSize(8192, p)).not.toThrow();
  });
  it('large transcript (tool result) must be artifact not inline', () => {
    // Simulate long tool result 50000 bytes
    const byteLength = 50000;
    const p = createSizePolicy();
    expect(shouldClaimCheck(byteLength, 'standard', p)).toBe(true);
    expect(() => validateWorkflowArgSize(byteLength, p)).toThrow();
  });
  it('defaults match config 8192/10485760', () => {
    expect(DEFAULT_MAX_INLINE_BYTES).toBe(8192);
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBe(10_485_760);
  });
});
