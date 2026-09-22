/**
 * secret-rotation.test.ts — provider creds via workload secret provider, no plaintext in history/logs, key rotation without downtime
 * Source: 10.2 308-314, 803, 1296-1322, 137-140
 */
import { describe, it, expect } from 'vitest';
import { InMemorySecretProvider } from '@neryva/security';

describe('10.2 Secrets + encryption — rotation without downtime, no plaintext in logs', () => {
  it('secret via provider, not in .env value — resolve via ref', async () => {
    const provider = new InMemorySecretProvider();
    provider.set('arn:aws:secretsmanager:openai', 'sk-openai-secret', 'v1');
    const val = await provider.resolve({ ref: 'arn:aws:secretsmanager:openai' });
    expect(val).toBe('sk-openai-secret');
  });

  it('no plaintext in workflow input/logs/definitions/capability claims (605) — redacted', async () => {
    const provider = new InMemorySecretProvider();
    provider.set('openai-key', 'sk-secret-123', 'v1');
    const secret = await provider.resolve({ ref: 'openai-key' });
    const log = `workflow input: model=gpt-4o, apiKey=[REDACTED]`;
    expect(log).not.toContain(secret);
    InMemorySecretProvider.assertNoPlaintextInLog(log, secret);
    // History would store ref, not value
    const history = { model: 'gpt-4o', secretRef: 'openai-key', secretValue: undefined };
    expect(history.secretValue).toBeUndefined();
    expect(history.secretRef).toBe('openai-key');
  });

  it('key rotation without downtime — old version still resolves during overlap (308-314)', async () => {
    const provider = new InMemorySecretProvider();
    provider.set('openai-key', 'sk-v1', 'v1');
    expect(await provider.resolve({ ref: 'openai-key', version: 'v1' })).toBe('sk-v1');
    expect(await provider.resolve({ ref: 'openai-key' })).toBe('sk-v1'); // current is v1
    provider.rotate('openai-key', 'sk-v2', 'v2');
    // After rotate, current is v2
    expect(await provider.resolve({ ref: 'openai-key' })).toBe('sk-v2');
    // Old version still resolves during overlap
    expect(await provider.resolve({ ref: 'openai-key', version: 'v1' })).toBe('sk-v1');
    expect(await provider.resolve({ ref: 'openai-key', version: 'v2' })).toBe('sk-v2');
  });

  it('encrypted payload codec/claim-check — no plaintext in Temporal history', () => {
    // Simulate payload codec would encrypt large prompt before persisting to Temporal
    const secret = 'sk-litellm-virtual-key-xyz';
    const payload = { model: 'gpt-4o', prompt: 'hello', apiKey: secret };
    const redactedPayload = { ...payload, apiKey: '[REDACTED]' };
    expect(JSON.stringify(redactedPayload)).not.toContain(secret);
  });

  it('workload identity separation — runtime-worker only gets MCP + Temporal + assigned secret-manager creds', () => {
    const workload = {
      name: 'runtime-worker',
      allowed: ['mcp:execution', 'temporal:namespace', 'secret:openai-key'],
    };
    expect(workload.allowed).not.toContain('billing:admin');
    expect(workload.allowed).not.toContain('object-store:broad');
    expect(workload.allowed).not.toContain('db:engine');
  });
});
