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

  it('redacts camelCase and separator variants of sensitive fields (wave-3 gap)', () => {
    // The pre-normalization lookup only matched the exact snake_case entry —
    // camelCase `apiKey` sailed through unredacted. Every variant below must
    // redact, while lookalike non-sensitive fields must pass through.
    for (const field of ['apiKey', 'api_key', 'api-key', 'APIKEY', 'capabilityToken', 'toolArgs']) {
      expect(isSensitiveField(field)).toBe(true);
      const out = redactObject({ [field]: 'sk-test-secret-value' } as Record<string, unknown>);
      expect(out[field]).toBe('[REDACTED]');
    }
    expect(isSensitiveField('organizationId')).toBe(false);
    expect(isSensitiveField('tokenize')).toBe(false);
    expect(redactObject({ organizationId: 'org_A' }).organizationId).toBe('org_A');
    // Nested camelCase keys redact too.
    const nested = redactObject({ config: { apiKey: 'sk-nested' } } as Record<string, unknown>);
    expect((nested.config as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });

  it('truncates large strings', () => {
    const big = 'a'.repeat(2000);
    const out = redactObject({ document: big });
    // document is sensitive, so redacted not truncated
    expect(out.document).toBe('[REDACTED]');
    const out2 = redactObject({ other: big } as any);
    // 'other' is not sensitive, but >1000 chars — redactValue truncates with the byte count
    expect(out2.other).toBe('[TRUNCATED 2000B]');
    // short non-sensitive strings pass through untouched
    expect(redactObject({ other: 'small' }).other).toBe('small');
  });
});
