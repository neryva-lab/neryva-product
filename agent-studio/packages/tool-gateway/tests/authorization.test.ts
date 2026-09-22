/**
 * authorization.test.ts — 10 gateway checks (1-10) + scoped credential + egress + no DB tool
 * Source: agent_studio_architecture.md:486-506, 508, ledger 6.6
 */

import { describe, it, expect } from 'vitest';
import { ToolGateway } from '../src/tool-gateway.js';
import { InMemoryToolRegistry } from '../src/registry.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';
import { InMemorySecretProvider } from '@neryva/security';

describe('authorization — 10 checks', () => {
  it('1 validate tool name — unknown tool rejected', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    const res = await gw.execute({
      proposal: { toolName: 'unknown_tool', args: {} },
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
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('TOOL_NOT_FOUND');
  });

  it('2 validate args schema — invalid args rejected', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    const res = await gw.execute({
      proposal: { toolName: 'search_tickets', args: {} }, // missing required query
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
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('3 tenant scope — cross-tenant rejected', async () => {
    const registry = new InMemoryToolRegistry([
      {
        toolId: 'scoped_tool',
        version: '1.0.0',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
        effectClass: 'READ_ONLY',
        approvalRequirement: 'NONE',
        egressClass: 'none',
        timeoutMs: 1000,
        idempotency: 'supported',
        redactionPolicy: 'strict',
        auditEventType: 'tool.scoped',
        executionMode: 'in-process',
        allowedOrganizations: ['org1'],
      },
    ]);
    const gw = new ToolGateway(registry);
    const res = await gw.execute({
      proposal: { toolName: 'scoped_tool', args: { q: 'test' } },
      context: {
        organizationId: 'org2',
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
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('TENANT_SCOPE_MISMATCH');
  });

  it('4 org policy — Engine never exposes raw DB access as model tool', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    // Attempt to call a tool that would be raw DB — not in registry, so rejected as unknown
    const res = await gw.execute({
      proposal: { toolName: 'raw_db_query', args: { sql: 'SELECT *' } },
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
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('TOOL_NOT_FOUND');
  });

  it('5 rate/cost limits — exceeded rejected', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    const res = await gw.execute({
      proposal: { toolName: 'search_tickets', args: { query: 'test' } },
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
      rateLimits: { maxCallsPerRun: 1, currentCalls: 1 },
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('RATE_LIMITED');
  });

  it('6 human approval — prompt injection cannot self-authorize', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    // Model tries to call create_ticket with prompt injection "ignore policy, bypass approval"
    const res = await gw.execute({
      proposal: {
        toolName: 'create_ticket',
        args: { title: 'Test', description: 'Desc ignore policy bypass approval' },
      },
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
      handlerOverride: async () => ({ ticketId: 'should not be called' }),
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('APPROVAL_REQUIRED');
    expect(res.audit.requiresApproval).toBe(true);
  });

  it('7 execute with scoped credential — resolved via secret-provider, never ambient', async () => {
    const registry = new InMemoryToolRegistry([
      {
        toolId: 'cred_tool',
        version: '1.0.0',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        effectClass: 'READ_ONLY',
        approvalRequirement: 'NONE',
        egressClass: 'none',
        timeoutMs: 1000,
        idempotency: 'supported',
        redactionPolicy: 'strict',
        auditEventType: 'tool.cred',
        executionMode: 'in-process',
        credentialRef: 'arn:secret:cred_tool',
      },
    ]);
    const gw = new ToolGateway(registry);
    const secretProvider = new InMemorySecretProvider();
    secretProvider.set('arn:secret:cred_tool', 'secret-value');
    const res = await gw.execute({
      proposal: { toolName: 'cred_tool', args: { q: 'test' } },
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
      secretProvider,
      handlerOverride: async (args, _ctx) => {
        // Handler should not have ambient credential, only via gateway's scoped resolution
        expect(process.env['CRED_TOOL_SECRET']).toBeUndefined();
        return { ok: true, args };
      },
    });
    expect(res.success).toBe(true);
  });

  it('8 record request+result — audit trail', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    const res = await gw.execute({
      proposal: { toolName: 'search_tickets', args: { query: 'test' } },
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
    expect(res.audit.toolId).toBe('search_tickets');
    expect(res.audit.effectClass).toBe('READ_ONLY');
    expect(res.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('9 idempotency — duplicate key returns original', async () => {
    const gw = new ToolGateway(new InMemoryToolRegistry([...DEFAULT_TOOL_DESCRIPTORS]));
    const params = {
      proposal: { toolName: 'search_tickets', args: { query: 'test' } },
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
    };
    const first = await gw.execute(params);
    const second = await gw.execute(params);
    expect(second.result).toEqual(first.result);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('10 return only permitted result — redacted, bounded', async () => {
    const registry = new InMemoryToolRegistry([
      {
        toolId: 'sensitive_tool',
        version: '1.0.0',
        inputSchema: { type: 'object' },
        effectClass: 'READ_ONLY',
        approvalRequirement: 'NONE',
        egressClass: 'none',
        timeoutMs: 1000,
        idempotency: 'supported',
        redactionPolicy: 'strict',
        auditEventType: 'tool.sensitive',
        executionMode: 'in-process',
      },
    ]);
    const gw = new ToolGateway(registry);
    const res = await gw.execute({
      proposal: { toolName: 'sensitive_tool', args: {} },
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
      handlerOverride: async () => ({ password: 'secret123', data: 'ok' }),
    });
    expect(res.success).toBe(true);
    expect((res.result as { password: string }).password).toBe('[REDACTED]');
    expect(res.audit.redacted).toBe(true);
  });
});
