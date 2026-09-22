import { describe, it, expect, beforeEach } from 'vitest';
import {
  redactAttributes,
  redactLogRecord,
  hashContent,
  setDiagnosticMode,
  isDiagnosticModeActive,
  REDACTED_FIELDS,
} from '../src/redaction.js';

describe('redaction (1153-1161 default no raw prompts/creds; 1504 sensitive absent)', () => {
  beforeEach(() => setDiagnosticMode(undefined));

  it('redacts prompt/completion/tool_args/document/credential', () => {
    const attrs = {
      prompt: 'secret prompt with credentials',
      completion: 'model output',
      tool_args: '{"secret":"sk-1234567890"}',
      document: 'full document content that is sensitive'.repeat(10),
      credential: 'Bearer token123',
      capability_token: 'cap_abc',
      normal_field: 'should remain',
    };
    const redacted = redactAttributes(attrs);
    expect(redacted.prompt).toBe('[REDACTED]');
    expect(redacted.completion).toBe('[REDACTED]');
    expect(redacted.tool_args).toBe('[REDACTED]');
    expect(redacted.document).toBe('[REDACTED]');
    expect(redacted.credential).toBe('[REDACTED]');
    expect(redacted.capability_token).toBe('[REDACTED]');
    expect(redacted.normal_field).toBe('should remain');
  });

  it('hashes long content instead of raw (store hashes/sizes, not raw)', () => {
    const longText = 'x'.repeat(500);
    const attrs = { tool_result: longText, normal: 'short' };
    const redacted = redactAttributes(attrs);
    expect(redacted.tool_result).toBe('[REDACTED]');
    // redactLogRecord adds byte_length
    const record = redactLogRecord({ tool_result: longText, prompt: 'p' });
    expect(record.tool_result).toBe('[REDACTED]');
    expect(record.tool_result_byte_length).toBe(500);
  });

  it('default mode: diagnostic content requires expiring authorized mode (1157)', () => {
    expect(isDiagnosticModeActive()).toBe(false);
    const attrs = { prompt: 'should be redacted', credential: 'sk-secret' };
    const redacted = redactAttributes(attrs);
    expect(redacted.prompt).toBe('[REDACTED]');
    // Enable diagnostic mode expiring
    setDiagnosticMode({
      enabled: true,
      expiresAt: new Date(Date.now() + 60_000),
      authorizedBy: 'admin',
      reason: 'debug',
    });
    expect(isDiagnosticModeActive()).toBe(true);
    const diag = redactAttributes(attrs);
    // In diagnostic mode, prompt allowed but credentials still redacted
    expect(diag.prompt).toBe('should be redacted');
    expect(diag.credential).toBe('[REDACTED]');
  });

  it('diagnostic mode expires', async () => {
    setDiagnosticMode({
      enabled: true,
      expiresAt: new Date(Date.now() + 10),
      authorizedBy: 'admin',
      reason: 'test',
    });
    expect(isDiagnosticModeActive()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(isDiagnosticModeActive()).toBe(false);
    const redacted = redactAttributes({ prompt: 'x' });
    expect(redacted.prompt).toBe('[REDACTED]');
  });

  it('hashContent is deterministic 16 hex', () => {
    const h1 = hashContent('hello');
    const h2 = hashContent('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });

  it('redactLogRecord stores hashes/sizes/classifications/artifact IDs not raw (1153)', () => {
    const record = redactLogRecord({
      prompt: 'very long prompt '.repeat(20),
      artifactId: 'art_123',
      byte_length: 1234,
      classification: 'standard',
      provider: 'openai',
    });
    expect(record.prompt).toBe('[REDACTED]');
    expect(record.artifactId).toBe('art_123');
    expect(record.byte_length).toBe(1234);
    expect(record.classification).toBe('standard');
    expect(record.provider).toBe('openai');
  });

  it('REDACTED_FIELDS contains expected denylist', () => {
    expect(REDACTED_FIELDS.has('prompt')).toBe(true);
    expect(REDACTED_FIELDS.has('credential')).toBe(true);
    expect(REDACTED_FIELDS.has('capability_token')).toBe(true);
  });

  it('no raw API keys in logs — sk- pattern redacted', () => {
    const attrs = { tool_args: 'sk-1234567890abcdef1234567890' };
    const redacted = redactAttributes(attrs);
    expect(String(redacted.tool_args)).not.toContain('sk-123');
    expect(redacted.tool_args).toBe('[REDACTED]');
  });
});
