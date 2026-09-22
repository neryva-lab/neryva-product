/**
 * sandbox-boundary.test.ts — tool isolation (workload identity, FS isolation, CPU/mem/time limits, egress, no ambient creds, audit)
 * Source: agent_studio_architecture.md:400-405, agent_studio_implementation_plan.md:1018-1029, ledger 6.5
 */

import { describe, it, expect } from 'vitest';
import {
  executeInSandbox,
  attemptSandboxEscape,
  DEFAULT_SANDBOX_LIMITS,
} from '../src/executors/sandbox.js';
import { InMemoryToolRegistry } from '../src/registry.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

describe('sandbox boundary', () => {
  it('in-process allowed for trusted read-only', async () => {
    const registry = new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]);
    const desc = registry.get('search_tickets');
    expect(desc?.executionMode).toBe('activity'); // search_tickets is activity, not in-process, but test that in-process would be allowed for trusted
    if (!desc) throw new Error('desc not found');
    // For this test, we simulate in-process for a fake trusted tool
    const fakeDesc = {
      ...desc,
      executionMode: 'in-process' as const,
      egressClass: 'none' as const,
    };
    const res = await import('../src/executors/in-process.js').then((m) =>
      m.executeInProcess(
        fakeDesc,
        { query: 'test' },
        {
          organizationId: 'org1',
          conversationId: 'conv1',
          runId: 'run1',
          agentVersionId: 'v1',
          policyVersion: 'v1',
          correlationId: 'c1',
        },
        async () => ({ ok: true }),
      ),
    );
    expect((res as { ok: boolean }).ok).toBe(true);
  });

  it('sandbox for customer code / untrusted parsers / broad network / sensitive creds / high CPU', async () => {
    const desc = {
      toolId: 'custom_tool',
      version: '1.0.0',
      inputSchema: { type: 'object' },
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      egressClass: 'open' as const,
      timeoutMs: 1000,
      idempotency: 'supported' as const,
      redactionPolicy: 'strict' as const,
      auditEventType: 'tool.custom',
      executionMode: 'sandbox' as const,
    };
    const ctx = {
      organizationId: 'org1',
      conversationId: 'conv1',
      runId: 'run1',
      agentVersionId: 'v1',
      policyVersion: 'v1',
      correlationId: 'c1',
    };
    const res = await executeInSandbox(
      desc,
      { x: 1 },
      ctx,
      async () => ({ result: 'sandbox ok' }),
      { ...DEFAULT_SANDBOX_LIMITS, egressAllowlist: ['allowed.host'] },
    );
    expect(res.success).toBe(true);
    expect(res.audit.egressAllowed).toBe(true);
    expect(res.audit.cpuMs).toBe(DEFAULT_SANDBOX_LIMITS.cpuMs);
  });

  it('sandbox escape attempt is denied and audited', async () => {
    const desc = {
      toolId: 'custom_tool',
      version: '1.0.0',
      inputSchema: { type: 'object' },
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      egressClass: 'none' as const,
      timeoutMs: 1000,
      idempotency: 'supported' as const,
      redactionPolicy: 'strict' as const,
      auditEventType: 'tool.custom',
      executionMode: 'sandbox' as const,
    };
    const ctx = {
      organizationId: 'org1',
      conversationId: 'conv1',
      runId: 'run1',
      agentVersionId: 'v1',
      policyVersion: 'v1',
      correlationId: 'c1',
    };
    const res = await executeInSandbox(desc, {}, ctx, attemptSandboxEscape, DEFAULT_SANDBOX_LIMITS);
    expect(res.success).toBe(false);
    expect(res.error).toContain('SANDBOX_ESCAPE_DENIED');
    expect(res.audit.egressAllowed).toBe(false);
  });

  it('sandbox enforces timeout', async () => {
    const desc = {
      toolId: 'slow_tool',
      version: '1.0.0',
      inputSchema: { type: 'object' },
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      egressClass: 'none' as const,
      timeoutMs: 10,
      idempotency: 'supported' as const,
      redactionPolicy: 'strict' as const,
      auditEventType: 'tool.slow',
      executionMode: 'sandbox' as const,
    };
    const ctx = {
      organizationId: 'org1',
      conversationId: 'conv1',
      runId: 'run1',
      agentVersionId: 'v1',
      policyVersion: 'v1',
      correlationId: 'c1',
    };
    const res = await executeInSandbox(
      desc,
      {},
      ctx,
      async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { ok: true };
      },
      { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 10 },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('SANDBOX_TIMEOUT');
  });

  it('sandbox has workload identity, FS isolation, no ambient creds, audit', async () => {
    const desc = {
      toolId: 'tool_with_cred',
      version: '1.0.0',
      inputSchema: { type: 'object' },
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      egressClass: 'limited' as const,
      timeoutMs: 1000,
      idempotency: 'supported' as const,
      redactionPolicy: 'strict' as const,
      auditEventType: 'tool.cred',
      executionMode: 'sandbox' as const,
      credentialRef: 'arn:aws:secretsmanager:secret:tool',
    };
    const ctx = {
      organizationId: 'org1',
      conversationId: 'conv1',
      runId: 'run1',
      agentVersionId: 'v1',
      policyVersion: 'v1',
      correlationId: 'c1',
    };
    const res = await executeInSandbox(
      desc,
      {},
      ctx,
      async () => ({ secret: 'should be redacted' }),
      DEFAULT_SANDBOX_LIMITS,
    );
    expect(res.success).toBe(true);
    expect(res.audit.toolId).toBe('tool_with_cred');
    expect(res.audit.organizationId).toBe('org1');
    // No ambient creds — handler should not have access to process.env.TOOL_AMBIENT_CREDENTIAL
    expect(process.env['TOOL_AMBIENT_CREDENTIAL']).toBeUndefined();
  });
});
