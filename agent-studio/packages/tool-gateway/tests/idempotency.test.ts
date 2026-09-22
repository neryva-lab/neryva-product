/**
 * idempotency.test.ts — Temporal at-least-once: stable key, persist before ack, reconcile, UNKNOWN_OUTCOME
 * Source: agent_studio_architecture.md:507-510, agent_studio_implementation_plan.md:1008-1017, ledger 6.4
 */

import { describe, it, expect } from 'vitest';
import { ToolGateway } from '../src/tool-gateway.js';
import { InMemoryToolRegistry } from '../src/registry.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';
import { deriveToolIdempotencyKey } from '../src/idempotency.js';

describe('idempotency — stable key, persist before ack, duplicate safe', () => {
  it('deriveToolIdempotencyKey is stable (run_id+step_id+tool_version)', () => {
    const k1 = deriveToolIdempotencyKey({
      runId: 'run1',
      stepId: 'step1',
      toolId: 'search_tickets',
      toolVersion: '1.0.0',
    });
    const k2 = deriveToolIdempotencyKey({
      runId: 'run1',
      stepId: 'step1',
      toolId: 'search_tickets',
      toolVersion: '1.0.0',
    });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('duplicate delivery does not duplicate fake external effect (create_ticket)', async () => {
    const registry = new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]);
    const gw = new ToolGateway(registry);
    const params = {
      proposal: { toolName: 'create_ticket', args: { title: 'Test', description: 'Desc' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run1',
        agentVersionId: 'agent_v1',
        policyVersion: 'v1',
        correlationId: 'corr1',
      },
      stepId: 'step1',
      runId: 'run1',
      policyVersion: 'v1',
    };
    // First call without approval should require approval
    const firstNoApproval = await gw.execute(params);
    expect(firstNoApproval.success).toBe(false);
    expect(firstNoApproval.errorCode).toBe('APPROVAL_REQUIRED');

    // With approval, first execution succeeds and persists
    const withApproval = await gw.execute({
      ...params,
      approvalDecision: { approvalId: 'aprv1', decision: 'APPROVED' },
      handlerOverride: async () => ({ ticketId: 'tk_123', title: 'Test' }),
    });
    expect(withApproval.success).toBe(true);
    expect(withApproval.outcome).toBe('SUCCESS');
    const key = withApproval.idempotencyKey;
    expect(key).toMatch(/^[a-f0-9]{64}$/);

    // Duplicate delivery with same runId+stepId+toolVersion should return original (idempotent)
    const duplicate = await gw.execute({
      ...params,
      approvalDecision: { approvalId: 'aprv1', decision: 'APPROVED' },
      handlerOverride: async () => ({ ticketId: 'tk_DUP', title: 'Dup' }), // different handler, but should not be called due to dedup
    });
    expect(duplicate.success).toBe(true);
    expect(duplicate.result).toEqual(withApproval.result); // same as original
    expect(duplicate.outcome).toBe('SUCCESS');
    expect(duplicate.idempotencyKey).toBe(key);
  });

  it('lost response → UNKNOWN_OUTCOME if unprovable (not silent success)', async () => {
    const registry = new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]);
    const gw = new ToolGateway(registry);
    const params = {
      proposal: { toolName: 'search_tickets', args: { query: 'test' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run2',
        agentVersionId: 'agent_v1',
        policyVersion: 'v1',
        correlationId: 'corr1',
      },
      stepId: 'step2',
      runId: 'run2',
      policyVersion: 'v1',
      handlerOverride: async () => {
        throw new Error('UNKNOWN_OUTCOME');
      },
    };
    const res = await gw.execute(params);
    // Gateway's handler catches UNKNOWN_OUTCOME and maps to UNKNOWN_OUTCOME, not SUCCESS
    // In our gateway, UNKNOWN_OUTCOME from handler is caught as TOOL_FAILED with UNKNOWN_OUTCOME outcome? Let's check
    // For this test, we simulate handler throwing UNKNOWN_OUTCOME, which gateway maps to UNKNOWN_OUTCOME
    expect(res.outcome).toBe('UNKNOWN_OUTCOME');
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('UNKNOWN_OUTCOME');
  });

  it('never blindly retry — second call with same key after UNKNOWN_OUTCOME remains UNKNOWN_OUTCOME', async () => {
    const registry = new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]);
    const gw = new ToolGateway(registry);
    const keyParams = {
      runId: 'run3',
      stepId: 'step3',
      toolId: 'search_tickets',
      toolVersion: '1.0.0',
    };
    const key = deriveToolIdempotencyKey(keyParams);
    // First: UNKNOWN_OUTCOME
    const first = await gw.execute({
      proposal: { toolName: 'search_tickets', args: { query: 'x' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run3',
        agentVersionId: 'agent_v1',
        policyVersion: 'v1',
        correlationId: 'corr1',
      },
      stepId: 'step3',
      runId: 'run3',
      policyVersion: 'v1',
      handlerOverride: async () => {
        throw new Error('UNKNOWN_OUTCOME');
      },
    });
    expect(first.outcome).toBe('UNKNOWN_OUTCOME');
    // Second: same key, should return same UNKNOWN_OUTCOME without re-executing handler that would succeed
    const second = await gw.execute({
      proposal: { toolName: 'search_tickets', args: { query: 'x' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run3',
        agentVersionId: 'agent_v1',
        policyVersion: 'v1',
        correlationId: 'corr1',
      },
      stepId: 'step3',
      runId: 'run3',
      policyVersion: 'v1',
      handlerOverride: async () => ({ tickets: [{ id: 't1' }] }), // would succeed if not deduped, but should be deduped to UNKNOWN_OUTCOME
    });
    expect(second.outcome).toBe('UNKNOWN_OUTCOME');
    expect(second.idempotencyKey).toBe(key);
  });
});
