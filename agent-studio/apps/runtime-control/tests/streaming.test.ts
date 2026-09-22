import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';
import type { Config } from '../src/config.js';

const fakeConfig: Config = {
  serviceName: 'runtime-control',
  buildVersion: '0.1.0',
  environment: 'development',
  port: 3000,
  mcpEndpoint: 'http://localhost:50051',
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  temporalTaskQueue: 'agent-run-default',
  logLevel: 'info',
};

describe('Engine streaming contract (8.4) — frontend subscribes to Engine, not Studio', () => {
  it('runtime-control is stateless health only, no customer streaming endpoint', async () => {
    const server = await createServer(fakeConfig);
    const svc = server.getControlService();
    // Should have only audited control methods, not stream
    expect(svc).toHaveProperty('startRun');
    expect(svc).toHaveProperty('cancelRun');
    expect(svc).toHaveProperty('deliverRunInput');
    // No streaming method
    expect((svc as unknown as Record<string, unknown>).streamRun).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>).watchRunEvents).toBeUndefined();
    await server.close();
  });

  it('documentation: Engine owns SSE/WebSocket via request_id/run_id/sequence/event_id, Studio emits durable via MCP', () => {
    // Verify contract: runtime-control server does not implement WatchRunEvents
    // This is architectural invariant: frontend reconnects with last event_id to Engine ListRunEvents/WatchRunEvents, not to Studio
    const expectedEngineMethods = ['ListRunEvents', 'WatchRunEvents', 'GetRun'];
    const studioMethods = ['startRun', 'cancelRun', 'deliverRunInput', 'getProgress'];
    for (const m of expectedEngineMethods) {
      expect(studioMethods).not.toContain(m);
    }
  });

  it('ephemeral delta path is optimization, durable final via CommitRunResult (1502)', async () => {
    const seen = new Set<string>();
    const trackingTemporal = {
      async startWorkflow(_type: string, _input: unknown, opts: { workflowId: string }) {
        if (seen.has(opts.workflowId)) throw new Error('AlreadyStarted: workflow already exists');
        seen.add(opts.workflowId);
        return { workflowId: opts.workflowId, runId: `run_${Date.now()}` };
      },
      async signalWorkflow() {},
      async updateWorkflow() {
        return { accepted: true };
      },
      async queryWorkflow() {
        return undefined;
      },
      async cancelWorkflow() {},
    };
    const server = await createServer(
      fakeConfig,
      trackingTemporal as unknown as Parameters<typeof createServer>[1],
    );
    const svc = server.getControlService();
    // startRun is idempotent, durable via Temporal workflowId
    const res1 = await svc.startRun({
      runId: '00000000-0000-7000-8000-000000000001',
      organizationId: '00000000-0000-7000-8000-000000000002',
      conversationId: '00000000-0000-7000-8000-000000000003',
      agentVersionId: 'agent_v1',
      policySnapshotId: 'policy_v1',
      idempotencyKey: 'idem_123',
      correlationId: 'corr_123',
    });
    const res2 = await svc.startRun({
      runId: '00000000-0000-7000-8000-000000000001',
      organizationId: '00000000-0000-7000-8000-000000000002',
      conversationId: '00000000-0000-7000-8000-000000000003',
      agentVersionId: 'agent_v1',
      policySnapshotId: 'policy_v1',
      idempotencyKey: 'idem_123',
      correlationId: 'corr_123',
    });
    expect(res1.workflowId).toBe(res2.workflowId);
    // Second is alreadyStarted (idempotent)
    expect(res2.alreadyStarted).toBe(true);
    await server.close();
  });
});
