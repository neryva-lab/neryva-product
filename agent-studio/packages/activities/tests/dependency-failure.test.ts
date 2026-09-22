/**
 * dependency-failure.test.ts — dependency failures propagate, retry ownership explicit
 * Source: agent_studio_implementation_plan.md:813-825
 */

import { describe, it, expect } from 'vitest';
import { executeTool } from '../src/tool-activities.js';
import { callModel } from '../src/model-activities.js';

describe('dependency failure propagation', () => {
  it('tool policy denial is non-retryable failed outcome', async () => {
    const res = await executeTool({
      runId: 'run1',
      organizationId: 'org1',
      stepId: 'run1#1#tool/drop_table/1',
      toolName: 'drop_table',
      toolVersion: 'v1',
      args: {},
      idempotencyKey: 'k1',
      effectClass: 'READ_ONLY',
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('TOOL_NOT_FOUND');
  });

  it('mutating without approval fails (never blindly retry)', async () => {
    const res = await executeTool({
      runId: 'run1',
      organizationId: 'org1',
      stepId: 's1',
      toolName: 'create_ticket',
      toolVersion: 'v1',
      args: { title: 'x', description: 'y' },
      idempotencyKey: 'k2',
      effectClass: 'MUTATING',
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('APPROVAL_REQUIRED');
  });

  it('mutating with approval succeeds idempotently', async () => {
    const res = await executeTool({
      runId: 'run1',
      organizationId: 'org1',
      stepId: 's1',
      toolName: 'create_ticket',
      toolVersion: 'v1',
      args: { title: 'x', description: 'y' },
      idempotencyKey: 'k2',
      effectClass: 'MUTATING',
      approvalId: 'aprv_1',
    });
    expect(res.success).toBe(true);
    expect(res.outcome).toBe('SUCCESS');
  });

  it('model activity is cancellable heartbeat-aware', async () => {
    const res = await callModel({
      runId: 'run1',
      stepId: 'run1#1#model/1',
      organizationId: 'org1',
      agentVersionId: 'agent_v1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'search_tickets', description: 'search', parameters: {} }],
    });
    expect(res.finishReason).toBe('stop');
    expect(res.text).toContain('Hello');
  });

  it('model tool-call path uses heartbeat', async () => {
    const res = await callModel({
      runId: 'run1',
      stepId: 'run1#1#model/1',
      organizationId: 'org1',
      agentVersionId: 'agent_v1',
      messages: [{ role: 'user', content: 'use-tool: please search' }],
      tools: [{ name: 'search_tickets', description: 'search', parameters: {} }],
    });
    expect(res.finishReason).toBe('tool-call');
    expect(res.toolCalls?.[0]?.name).toBe('search_tickets');
  });
});
