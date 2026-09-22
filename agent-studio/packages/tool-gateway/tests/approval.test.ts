/**
 * approval.test.ts — approval bridge auditable + correlated to one logical tool_call_id/step_id
 * Source: agent_studio_implementation_plan.md:1102-1117, 1116, ledger 6.7
 * Approval is idempotent, scoped to org/run/tool_call/approval_id/policy_version, one-time ID
 */

import { describe, it, expect } from 'vitest';
import { createApprovalBridge } from '../src/approval-bridge.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { InMemoryToolRegistry } from '../src/registry.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

describe('approval — auditable, correlated, idempotent', () => {
  it('createApprovalRequest is auditable and correlated to stepId/toolCallId', async () => {
    const bridge = createApprovalBridge();
    const req = await bridge.createRequest({
      organizationId: 'org1',
      runId: 'run1',
      toolCallId: 'call1',
      stepId: 'step1',
      toolId: 'create_ticket',
      toolVersion: '1.0.0',
      effectClass: 'MUTATING',
      policyVersion: 'v1',
    });
    expect(req.approvalId).toContain('aprv_');
    expect(req.organizationId).toBe('org1');
    expect(req.runId).toBe('run1');
    expect(req.toolCallId).toBe('call1');
    expect(req.stepId).toBe('step1');
    expect(req.policyVersion).toBe('v1');
    expect(req.requestedAt).toBeDefined();
  });

  it('approval decision is one-time ID, idempotent', async () => {
    const bridge = createApprovalBridge();
    const req = await bridge.createRequest({
      organizationId: 'org1',
      runId: 'run1',
      toolCallId: 'call1',
      stepId: 'step1',
      toolId: 'create_ticket',
      toolVersion: '1.0.0',
      effectClass: 'MUTATING',
      policyVersion: 'v1',
    });
    const dec1 = await bridge.decide(req, { decidedBy: 'user1', decision: 'APPROVED' });
    const dec2 = await bridge.decide(req, {
      decidedBy: 'user1',
      decision: 'APPROVED',
      correlationId: dec1.correlationId,
    });
    // Same correlationId → same decision (idempotent)
    expect(dec1.correlationId).toBe(dec2.correlationId);
    expect(dec1.approvalId).toBe(req.approvalId);
  });

  it('approval validates correlation — stepId/toolCallId must match', async () => {
    const bridge = createApprovalBridge();
    const req = await bridge.createRequest({
      organizationId: 'org1',
      runId: 'run1',
      toolCallId: 'call1',
      stepId: 'step1',
      toolId: 'create_ticket',
      toolVersion: '1.0.0',
      effectClass: 'MUTATING',
      policyVersion: 'v1',
    });
    const dec = await bridge.decide(req, { decidedBy: 'user1', decision: 'APPROVED' });
    const ok = bridge.validate(req, dec);
    expect(ok.ok).toBe(true);

    const badDec = { ...dec, stepId: 'wrong_step' };
    const bad = bridge.validate(req, badDec);
    expect(bad.ok).toBe(false);
  });

  it('approval is auditable — gateway records approvalId in audit', async () => {
    const registry = new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]);
    const gw = new ToolGateway(registry);
    // Without approval, mutating should require approval
    const noApproval = await gw.execute({
      proposal: { toolName: 'create_ticket', args: { title: 'T', description: 'D' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run1',
        agentVersionId: 'v1',
        policyVersion: 'v1',
        correlationId: 'c1',
      },
      stepId: 'step1',
      runId: 'run1',
      policyVersion: 'v1',
    });
    expect(noApproval.errorCode).toBe('APPROVAL_REQUIRED');
    expect(noApproval.audit.requiresApproval).toBe(true);

    // With approval, succeeds and audit shows approved
    const withApproval = await gw.execute({
      proposal: { toolName: 'create_ticket', args: { title: 'T', description: 'D' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run1',
        agentVersionId: 'v1',
        policyVersion: 'v1',
        correlationId: 'c1',
      },
      stepId: 'step1',
      runId: 'run1',
      policyVersion: 'v1',
      approvalDecision: { approvalId: 'aprv1', decision: 'APPROVED' },
      handlerOverride: async () => ({ ticketId: 'tk1' }),
    });
    expect(withApproval.success).toBe(true);
    expect(withApproval.audit.approved).toBe(true);
  });

  it('model cannot self-authorize — approval must come via gateway, not model output', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    // Model tries to call mutating tool without approvalDecision — even with valid args, gateway requires explicit approval
    const res = await gw.execute({
      proposal: { toolName: 'create_ticket', args: { title: 'T', description: 'D' } },
      context: {
        organizationId: 'org1',
        conversationId: 'conv1',
        runId: 'run1',
        agentVersionId: 'v1',
        policyVersion: 'v1',
        correlationId: 'c1',
      },
      stepId: 'step1',
      runId: 'run1',
      policyVersion: 'v1',
    });
    // Gateway still requires explicit approvalDecision, not args
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('APPROVAL_REQUIRED');
  });
});
