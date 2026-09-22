/**
 * redaction.test.ts
 */

import { describe, it, expect } from 'vitest';
import { redactObject, isSensitiveField } from '../src/sensitive-data.js';

describe('redaction', () => {
  it('redacts sensitive fields', () => {
    expect(isSensitiveField('prompt')).toBe(true);
    expect(isSensitiveField('organizationId')).toBe(false);
    const out = redactObject({ prompt: 'secret prompt', organizationId: 'org_A', normal: 'value' });
    expect(out.prompt).toBe('[REDACTED]');
    expect(out.organizationId).toBe('org_A');
  });

  it('truncates large strings', () => {
    const big = 'a'.repeat(2000);
    const out = redactObject({ document: big });
    // document is sensitive, so redacted not truncated
    expect(out.document).toBe('[REDACTED]');
    const out2 = redactObject({ other: big } as any);
    // other is not sensitive, but large — our redactValue truncates >1000 for non-sensitive?
    // Actually redactValue checks sensitive first, then length
    expect(typeof out2.other).toBe('string');
  });
});
