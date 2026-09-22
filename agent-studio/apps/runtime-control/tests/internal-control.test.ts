/**
 * internal-control.test.ts — RuntimeControlService admission + Signals/Updates
 * Source: ledger 3.6, neryva_mcp_implementation_plan.md:348-366
 */

import { describe, it, expect, vi } from 'vitest';
import { RuntimeControlService, deriveWorkflowId } from '../src/routes/internal-control.js';

describe('RuntimeControlService', () => {
  it('deriveWorkflowId is deterministic (one workflow per runId, no duplicate)', () => {
    const runId = '0192f2e2-7d7b-7b3a-8b3a-123456789abc';
    expect(deriveWorkflowId(runId)).toBe('agent-run::' + runId);
  });

  it('startRun is deterministic WorkflowId and idempotent on AlreadyStarted', async () => {
    const temporal = {
      startWorkflow: vi.fn(async (_type: string, _input: unknown, opts: { workflowId: string }) => {
        // Simulate AlreadyStarted on second call
        if ((temporal as unknown as { called: boolean }).called)
          throw new Error('WorkflowExecutionAlreadyStarted');
        (temporal as unknown as { called: boolean }).called = true;
        return { workflowId: opts.workflowId, runId: 'temporal-run-1' };
      }),
      signalWorkflow: vi.fn(async () => {}),
      updateWorkflow: vi.fn(async () => ({})),
      queryWorkflow: vi.fn(async () => undefined),
      cancelWorkflow: vi.fn(async () => {}),
    } as unknown as ConstructorParameters<typeof RuntimeControlService>[0];
    (temporal as unknown as { called: boolean }).called = false;

    const mcp = {};
    const svc = new RuntimeControlService(temporal, mcp, 'agent-run-default');
    const input = {
      runId: '0192f2e2-7d7b-7b3a-8b3a-123456789abc',
      organizationId: '0192f2e2-7d7b-7b3a-8b3a-aaaaaaaaaaaa',
      conversationId: '0192f2e2-7d7b-7b3a-8b3a-bbbbbbbbbbbb',
      agentVersionId: 'agent_v1',
      policySnapshotId: 'pol_1',
      idempotencyKey: 'idem_123',
      correlationId: 'corr_123',
    };
    const first = await svc.startRun(input);
    expect(first.workflowId).toBe(deriveWorkflowId(input.runId));
    expect(first.alreadyStarted).toBe(false);
    const second = await svc.startRun(input);
    expect(second.workflowId).toBe(deriveWorkflowId(input.runId));
    expect(second.alreadyStarted).toBe(true);
  });

  it('cancelRun signals CancelRun (durable) and audits', async () => {
    const signalWorkflow = vi.fn(async () => {});
    const temporal = {
      startWorkflow: vi.fn(async () => ({ workflowId: 'w', runId: 'r' })),
      signalWorkflow,
      updateWorkflow: vi.fn(async () => ({})),
      queryWorkflow: vi.fn(async () => undefined),
      cancelWorkflow: vi.fn(async () => {}),
    } as unknown as ConstructorParameters<typeof RuntimeControlService>[0];
    const audit = vi.fn();
    const svc = new RuntimeControlService(temporal, {}, 'agent-run-default', audit);
    await svc.cancelRun({
      runId: '0192f2e2-7d7b-7b3a-8b3a-123456789abc',
      reason: 'user',
      requestedBy: 'user_1',
    });
    expect(signalWorkflow).toHaveBeenCalledWith(
      expect.stringContaining('agent-run::'),
      'CancelRun',
      expect.objectContaining({ reason: 'user' }),
    );
    expect(audit).toHaveBeenCalledWith('CancelRun', expect.objectContaining({ reason: 'user' }));
  });

  it('deliverRunInput uses Signal by default, Update when sync validation', async () => {
    const signalWorkflow = vi.fn(async () => {});
    const updateWorkflow = vi.fn(async () => ({ accepted: true }));
    const temporal = {
      startWorkflow: vi.fn(async () => ({ workflowId: 'w', runId: 'r' })),
      signalWorkflow,
      updateWorkflow,
      queryWorkflow: vi.fn(async () => undefined),
      cancelWorkflow: vi.fn(async () => {}),
    } as unknown as ConstructorParameters<typeof RuntimeControlService>[0];
    const svc = new RuntimeControlService(temporal, {}, 'agent-run-default');

    const base = {
      runId: '0192f2e2-7d7b-7b3a-8b3a-123456789abc',
      requestId: 'req_1',
      inputType: 'USER_MESSAGE' as const,
      payload: { text: 'hello' },
      idempotencyKey: 'idem_1',
    };
    const viaSignal = await svc.deliverRunInput(base);
    expect(viaSignal.via).toBe('signal');
    expect(signalWorkflow).toHaveBeenCalled();

    const viaUpdate = await svc.deliverRunInput({ ...base, requireSyncValidation: true });
    expect(viaUpdate.via).toBe('update');
    expect(updateWorkflow).toHaveBeenCalled();
  });
});
