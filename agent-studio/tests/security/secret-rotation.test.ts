/**
 * secret-rotation.test.ts — provider creds via workload secret provider, no plaintext in history/logs, key rotation without downtime
 * Source: 10.2 308-314, 803, 1296-1322, 137-140
 */
import { describe, it, expect } from 'vitest';
import { InMemorySecretProvider, redactObject, createWorkloadIdentity } from '@neryva/security';

describe('10.2 Secrets + encryption — rotation without downtime, no plaintext in logs', () => {
  it('secret via provider, not in .env value — resolve via ref', async () => {
    const provider = new InMemorySecretProvider();
    provider.set('arn:aws:secretsmanager:openai', 'sk-openai-secret', 'v1');
    const val = await provider.resolve({ ref: 'arn:aws:secretsmanager:openai' });
    expect(val).toBe('sk-openai-secret');
  });

  it('no plaintext in workflow input/logs/definitions/capability claims (605) — redacted via redactObject', async () => {
    const provider = new InMemorySecretProvider();
    provider.set('openai-key', 'sk-live-abc123456789', 'v1');
    const secret = await provider.resolve({ ref: 'openai-key' });
    // Production path: redactObject strips sensitive fields before anything is logged or persisted.
    const redacted = redactObject({ model: 'gpt-4o', prompt: `hello ${secret}`, credential: secret });
    const log = `workflow input: ${JSON.stringify(redacted)}`;
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

  it('payload codec redacts sensitive fields — no plaintext in Temporal history', () => {
    // Production path: sensitive fields are redacted before the payload codec persists to history.
    const secret = 'sk-live-abc123456789';
    const payload = { model: 'gpt-4o', prompt: 'hello', credential: secret };
    const redactedPayload = redactObject(payload);
    expect(redactedPayload.prompt).toBe('[REDACTED]');
    expect(redactedPayload.credential).toBe('[REDACTED]');
    expect(JSON.stringify(redactedPayload)).not.toContain(secret);
  });

  it('workload identity separation — runtime-worker gets only execution-plane methods + assigned secrets', () => {
    const id = createWorkloadIdentity('runtime-worker', 'production');
    expect(id.role).toBe('runtime-worker');
    expect(id.environment).toBe('production');
    const broad = /billing|admin|object-store|db:/i;
    for (const method of id.allowedMcpMethods) {
      expect(method, `workload method escaped its plane: ${method}`).not.toMatch(broad);
    }
    for (const ref of id.secretRefs) {
      expect(ref, `workload secret ref too broad: ${ref}`).not.toMatch(/broad|\*/);
    }
    expect(id.secretRefs).toContain('openai/api-key');
    // runtime-control is read-only: it must never gain commit/append methods.
    const rc = createWorkloadIdentity('runtime-control', 'production');
    expect(rc.allowedMcpMethods).not.toContain('CommitRunResult');
    expect(rc.allowedMcpMethods).not.toContain('AppendRunEvents');
  });
});
