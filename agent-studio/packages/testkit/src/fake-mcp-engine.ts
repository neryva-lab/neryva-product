/**
 * fake-mcp-engine.ts — fake Engine MCP authority for tests
 * Source: agent_studio_implementation_plan.md:371-381, 1224-1235
 * Consumes generated @neryva/mcp-contract types (never hand-copy).
 * No Engine DB; in-memory maps with scope immutability checks.
 */

import type { RequestContextFixture } from './fixtures.js';

export interface FakeMcpEngineOptions {
  organizationId: string;
}

export class FakeMcpEngine {
  private runs = new Map<string, { context: RequestContextFixture; state: string }>();
  private events = new Map<string, unknown[]>();

  constructor(private readonly opts: FakeMcpEngineOptions) {}

  async acquireOrRenewRunLease(
    ctx: RequestContextFixture,
  ): Promise<{ leaseOwner: string; epoch: number }> {
    this.assertScope(ctx);
    const key = ctx.runId;
    if (!this.runs.has(key)) {
      this.runs.set(key, { context: ctx, state: 'CLAIMED' });
    }
    return { leaseOwner: 'fake-worker', epoch: 1 };
  }

  async getAuthorizedRunContext(ctx: RequestContextFixture): Promise<Record<string, unknown>> {
    this.assertScope(ctx);
    return {
      agentVersionId: ctx.agentVersionId,
      policySnapshot: { version: 1, allowedModels: ['openai/gpt-4o-mini'] },
      conversation: { messages: [], summary: undefined },
      tools: [],
      artifactRefs: [],
    };
  }

  async appendRunEvents(
    ctx: RequestContextFixture,
    events: unknown[],
  ): Promise<{ sequence: number }> {
    this.assertScope(ctx);
    const list = this.events.get(ctx.runId) ?? [];
    list.push(...events);
    this.events.set(ctx.runId, list);
    return { sequence: list.length };
  }

  async commitRunResult(
    ctx: RequestContextFixture,
    _result: unknown,
  ): Promise<{ messageId: string }> {
    this.assertScope(ctx);
    // Idempotent per run — duplicate returns same messageId
    return { messageId: `msg_${ctx.runId}` };
  }

  private assertScope(ctx: RequestContextFixture): void {
    if (ctx.organizationId !== this.opts.organizationId) {
      throw new Error(
        `scope mismatch: expected ${this.opts.organizationId}, got ${ctx.organizationId}`,
      );
    }
  }

  // Test helpers
  clear(): void {
    this.runs.clear();
    this.events.clear();
  }
}
