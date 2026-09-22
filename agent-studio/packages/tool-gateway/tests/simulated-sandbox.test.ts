/**
 * simulated-sandbox.test.ts — SIMULATED sandbox executor honesty tests.
 *
 * The executor under test (`executeInSimulatedSandbox`) provides NO real
 * isolation: the handler runs in-process with full host access. These tests
 * assert exactly what is enforced (timeout race, static egress validation,
 * ambient-credential marker check, audit record) and — deliberately — assert
 * what is NOT enforced, so no future change can silently re-claim isolation
 * against this executor.
 *
 * Source: agent_studio_architecture.md:400-405, agent_studio_implementation_plan.md:1018-1029, ledger 6.5
 * TODO(owner: release loop): replace with HttpSandboxExecutor tests against a
 * real E2B-OSS/Daytona backend per docs/design/fl-2.11-sandbox-code-interpreter.md.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeInSimulatedSandbox,
  DEFAULT_SIMULATED_SANDBOX_LIMITS,
} from '../src/executors/sandbox.js';
import { InMemoryToolRegistry } from '../src/registry.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

function makeDesc(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function makeCtx() {
  return {
    organizationId: 'org1',
    conversationId: 'conv1',
    runId: 'run1',
    agentVersionId: 'v1',
    policyVersion: 'v1',
    correlationId: 'c1',
  };
}

describe('simulated sandbox', () => {
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

  it('simulated sandbox runs the handler and marks the audit record simulated', async () => {
    const res = await executeInSimulatedSandbox(
      makeDesc({ egressClass: 'open' as const }),
      { x: 1 },
      makeCtx(),
      async () => ({ result: 'sandbox ok' }),
      { ...DEFAULT_SIMULATED_SANDBOX_LIMITS, egressAllowlist: ['allowed.host'] },
    );
    expect(res.success).toBe(true);
    expect(res.audit.sandboxKind).toBe('simulated');
    expect(res.audit.egressAllowed).toBe(true);
    // cpuMs/memoryMb are the configured policy values, echoed — not measured or enforced.
    expect(res.audit.cpuMs).toBe(DEFAULT_SIMULATED_SANDBOX_LIMITS.cpuMs);
    expect(res.audit.memoryMb).toBe(DEFAULT_SIMULATED_SANDBOX_LIMITS.memoryMb);
  });

  it('simulated sandbox rejects open egress without an allowlist (static policy check)', async () => {
    const res = await executeInSimulatedSandbox(
      makeDesc({ egressClass: 'open' as const }),
      {},
      makeCtx(),
      async () => ({ unreachable: true }),
      DEFAULT_SIMULATED_SANDBOX_LIMITS,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('SIMULATED_SANDBOX_EGRESS_DENIED');
  });

  it('simulated sandbox enforces timeout but does NOT cancel the handler', async () => {
    let handlerFinished = false;
    const res = await executeInSimulatedSandbox(
      makeDesc({ toolId: 'slow_tool', auditEventType: 'tool.slow' }),
      {},
      makeCtx(),
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        handlerFinished = true;
        return { ok: true };
      },
      { ...DEFAULT_SIMULATED_SANDBOX_LIMITS, timeoutMs: 10 },
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('SIMULATED_SANDBOX_TIMEOUT');
    // The timed-out handler keeps executing in this process — there is no
    // cancellation. This test documents that leak; do not "fix" it here.
    await new Promise((r) => setTimeout(r, 150));
    expect(handlerFinished).toBe(true);
  });

  it('simulated sandbox refuses when the ambient-credential marker is set', async () => {
    process.env['TOOL_AMBIENT_CREDENTIAL'] = 'test-marker';
    try {
      const res = await executeInSimulatedSandbox(
        makeDesc(),
        {},
        makeCtx(),
        async () => ({ unreachable: true }),
        DEFAULT_SIMULATED_SANDBOX_LIMITS,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('SIMULATED_SANDBOX_AMBIENT_CREDENTIAL_DETECTED');
    } finally {
      delete process.env['TOOL_AMBIENT_CREDENTIAL'];
    }
  });

  it('HONESTY: handler runs in-process — it CAN read /etc/passwd, process.env, and write outside any root', async () => {
    const probeFile = path.join(os.tmpdir(), `simulated-sandbox-honesty-${Date.now()}.txt`);
    const res = await executeInSimulatedSandbox(
      makeDesc(),
      {},
      makeCtx(),
      async () => {
        const passwdHead = fs.readFileSync('/etc/passwd', 'utf8').slice(0, 20);
        const homeVisible = typeof process.env['HOME'] === 'string';
        fs.writeFileSync(probeFile, 'no-fs-isolation');
        const wroteOutsideRoot = fs.existsSync(probeFile);
        return { passwdHead, homeVisible, wroteOutsideRoot };
      },
      DEFAULT_SIMULATED_SANDBOX_LIMITS,
    );
    try {
      expect(res.success).toBe(true);
      const result = res.result as { passwdHead: string; homeVisible: boolean; wroteOutsideRoot: boolean };
      // If any of these fail, someone has added REAL isolation — update the
      // executor's documentation and rename accordingly instead of weakening this test.
      expect(result.passwdHead.length).toBeGreaterThan(0);
      expect(result.homeVisible).toBe(true);
      expect(result.wroteOutsideRoot).toBe(true);
    } finally {
      if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
    }
  });
});
