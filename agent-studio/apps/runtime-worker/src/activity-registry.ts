/**
 * activity-registry.ts — assembles all Activities for Temporal Worker
 * Source: agent_studio_implementation_plan.md:808-824, 508-520
 * All non-deterministic work lives here; workflows proxy them.
 * One shared worker serves many runs: MCP activities resolve a per-run scoped client
 * (scope + Engine-issued capability) via the McpClientManager — never a worker-wide client.
 */

import { Context } from '@temporalio/activity';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import type { McpClientManager } from './dependencies.js';
import {
  createMcpActivities,
  createContextActivities,
  createModelActivities,
  createToolActivities,
  createApprovalActivities,
  createMemoryActivities,
  createUsageActivities,
  createEventActivities,
  createArtifactActivities,
  createGuardrailActivities,
  createCheckpointActivities,
} from '@neryva/activities';
import { resolveModerationHook, type ModerationHook } from '@neryva/security';
import { EngineSecretProvider } from '@neryva/activities';

export interface ActivityRegistryOptions {
  manager: McpClientManager;
  /** Guardrail config (FL-1.4) — resolved into the moderation hook. */
  moderation?: {
    provider: 'noop' | 'openai_compatible';
    baseUrl: string | undefined;
    apiKey: string | undefined;
    model: string;
    timeoutMs: number;
    isProduction: boolean;
  };
}

/** Extract runId from the Temporal activity context (workflowId = `agent-run::<runId>`). */
function currentRunId(): string {
  try {
    const info = Context.current().info;
    const wfId = info.workflowExecution?.workflowId;
    const match = typeof wfId === 'string' ? /^agent-run::(.+)$/.exec(wfId) : undefined;
    if (match?.[1]) return match[1];
  } catch {
    // outside activity context
  }
  throw new Error('MCP_RUN_ID_UNRESOLVABLE: activity invoked outside a run workflow');
}

/**
 * Lazily-scoped client proxy: each method call resolves the CURRENT run's client.
 * Fail-closed — throws MCP_RUN_NOT_CLAIMED if the run has no claimed client yet.
 */
function runScopedClient(manager: McpClientManager): NeryvaMcpClient {
  return new Proxy({} as NeryvaMcpClient, {
    get(_target, prop) {
      const client = manager.clientForRun(currentRunId());
      const value = (client as unknown as Record<string, unknown>)[prop as string];
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(client);
      }
      return value;
    },
  });
}

export function createActivityRegistry(opts: ActivityRegistryOptions): Record<string, unknown> {
  const mcp = createMcpActivities(runScopedClient(opts.manager));
  const context = createContextActivities(runScopedClient(opts.manager));
  // REL-1.5 — the model gateway resolves provider keys per call through the
  // Engine's audited GetToolCredential rail; the run-scoped client proxy
  // makes every activity call resolve the CURRENT run's capability.
  const model = createModelActivities(undefined, new EngineSecretProvider(runScopedClient(opts.manager)));
  const tool = createToolActivities({
    requestHandoff: async (runId: string, args: unknown) => {
      const reasonArg = (args as { reason?: unknown } | null)?.reason;
      const reason = typeof reasonArg === 'string' && reasonArg.trim() ? reasonArg : 'tool:request_human_handoff';
      const client = runScopedClient(opts.manager);
      return client.requestHumanHandoff({ reason });
    },
  });
  const approval = createApprovalActivities(runScopedClient(opts.manager));
  const memory = createMemoryActivities(runScopedClient(opts.manager));
  const usage = createUsageActivities(runScopedClient(opts.manager));
  const events = createEventActivities({
    client: runScopedClient(opts.manager),
    producerId: 'runtime-worker',
  });

  // FL-1.4 — runtime moderation for the Temporal path; the workflow screens
  // user input at run start and assistant output pre-commit via this activity.
  const moderationHook: ModerationHook = resolveModerationHook({
    provider: opts.moderation?.provider ?? 'noop',
    baseUrl: opts.moderation?.baseUrl ?? '',
    apiKey: opts.moderation?.apiKey ?? '',
    model: opts.moderation?.model ?? 'omni-moderation-latest',
    timeoutMs: opts.moderation?.timeoutMs ?? 3000,
    isProduction: opts.moderation?.isProduction ?? false,
  });
  const guardrails = createGuardrailActivities({ moderation: moderationHook });
  const checkpoints = createCheckpointActivities({ client: runScopedClient(opts.manager) });

  // Merge — names must be unique across classes; event activities contribute
  // emitEvent/emitBatch (their commitRunResult is superseded by the MCP one below).
  const registry: Record<string, unknown> = {
    // MCP (incl. commitRunResult / failRun — terminal, idempotent)
    ...mcp,
    // Context
    ...context,
    // Events (durable semantic)
    emitEvent: events.emitEvent,
    emitBatch: events.emitBatch,
    // Model
    ...model,
    // Tool
    ...tool,
    // Approval
    ...approval,
    // Memory
    ...memory,
    // Usage
    ...usage,
    // Artifacts
    ...createArtifactActivities(),
    // Guardrails (FL-1.4)
    moderateContent: guardrails.moderateContent,
    // Checkpoints (FL-2.17)
    saveCheckpoint: checkpoints.saveCheckpoint,
    loadCheckpoint: checkpoints.loadCheckpoint,
  };

  // Claim is bootstrap-aware: pre-claim there is no run client yet, so the claim
  // activity uses the bootstrap identity and upgrades the cached client when the
  // Engine-issued capability arrives in the claim response.
  registry['acquireOrRenewRunLease'] = async (params: {
    scope: Parameters<ReturnType<typeof createMcpActivities>['acquireOrRenewRunLease']>[0] extends infer P
      ? P extends { scope: infer S }
        ? S
        : never
      : never;
    expectedLeaseOwner?: string;
    expectedLeaseEpoch?: bigint;
  }) => {
    const bootstrap = opts.manager.bootstrapClient(params.scope);
    const res: unknown = await bootstrap.claimRun({
      expectedLeaseOwner: params.expectedLeaseOwner,
      expectedLeaseEpoch: params.expectedLeaseEpoch,
    });
    // Post-claim upgrade: Engine-issued capability in the claim response replaces the
    // bootstrap identity. Guarded — absence keeps the bootstrap client (fail-closed for
    // mutating RPCs, which the bootstrap capability does not allow).
    if (typeof res === 'object' && res !== null) {
      const cap = (res as Record<string, unknown>)['capability'];
      if (typeof cap === 'object' && cap !== null) {
        opts.manager.upgradeClient(params.scope, cap as never);
      }
    }
    return res;
  };

  return registry;
}

export type ActivityRegistry = ReturnType<typeof createActivityRegistry>;
