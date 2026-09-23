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
import { EngineSecretProvider, toUint64 } from '@neryva/activities';
import {
  isRecoveryMaterial,
  RECOVERY_FAILED_PREFIX,
  type RecoveryMaterial,
  type RecoveryScope,
} from '@neryva/activities';

/**
 * Convert the Engine's claim response to a Temporal-serializable plain object.
 * The protobuf response carries uint64 fields as BigInt, which Temporal's
 * payload converter cannot serialize. The workflow's extractBigint accepts
 * either bigint or number, so numbers are safe.
 */
function toSerializableClaim(res: unknown): unknown {
  const r = res as Record<string, unknown>;
  const run = r['run'] as Record<string, unknown> | undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : undefined;
  return {
    leaseEpoch: num(r['leaseEpoch'] ?? r['epoch']),
    epoch: num(r['leaseEpoch'] ?? r['epoch']),
    acquired: r['acquired'] === true,
    run: run
      ? {
          version: num(run['version']),
          runVersion: num(run['version']),
        }
      : undefined,
  };
}
function parseStaleLeaseDetails(err: unknown): { leaseOwner: string; actualEpoch: number } | null {
  const connectErr =
    err instanceof Error && (err as { cause?: unknown }).cause instanceof Error
      ? ((err as { cause?: unknown }).cause as Error)
      : err instanceof Error
        ? err
        : null;
  if (!connectErr) return null;
  const metadata = (connectErr as unknown as { metadata?: { get(name: string): string | null } })
    .metadata;
  const detailsHeader = metadata?.get('details') ?? null;
  if (!detailsHeader) return null;
  try {
    const details = JSON.parse(detailsHeader) as Record<string, unknown>;
    const leaseOwner = details['lease_owner'];
    const actualEpoch = details['actual_epoch'];
    if (typeof leaseOwner === 'string' && typeof actualEpoch === 'number') {
      return { leaseOwner, actualEpoch };
    }
  } catch {
    // malformed details — not a parseable stale-lease conflict
  }
  return null;
}

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

/**
 * Minimal manager surface the recovery wrapper needs. The real
 * McpClientManager satisfies it structurally; unit tests use fakes.
 * Exported for tests.
 */
export interface RunClientRecoveryManager {
  clientForRun(runId: string): unknown;
  dispatchClient(
    scope: RecoveryScope,
    capabilityToken: string,
    capabilityId: string,
  ): {
    claimRun(params: {
      expectedLeaseOwner?: string;
      expectedLeaseEpoch?: bigint;
    }): Promise<unknown>;
  };
  evictRun(runId: string): void;
}

function hasRunClient(manager: RunClientRecoveryManager, runId: string): boolean {
  try {
    manager.clientForRun(runId);
    return true;
  } catch {
    return false;
  }
}

/** In-flight reconstructions, single-flight per run (a fresh worker can run concurrent activities). */
const recoveryFlights = new Map<string, Promise<void>>();

/**
 * Reconstruct the run's MCP client from the Engine-issued dispatch capability
 * and re-acquire/renew the Engine lease BEFORE the retried activity runs.
 * Same-owner stale-epoch renewal (mirrors admission); another owner is never
 * stolen. On any failure the partially-cached client is evicted and a
 * RUN_RECOVERY_FAILED error is thrown — never a silent unclaimed client.
 */
async function recoverRunClient(
  manager: RunClientRecoveryManager,
  recovery: RecoveryMaterial,
): Promise<void> {
  const runId = recovery.scope.runId;
  // Double-check inside the flight: a concurrent activity may have
  // reconstructed while this one waited for the single-flight slot.
  if (hasRunClient(manager, runId)) return;
  try {
    if (!recovery.capabilityToken || !recovery.capabilityId) {
      throw new Error('no dispatch capability to reconstruct the run client');
    }
    const client = manager.dispatchClient(
      recovery.scope,
      recovery.capabilityToken,
      recovery.capabilityId,
    );
    const owner = `agent-studio:${recovery.scope.actorId}`;
    const epoch = toUint64(recovery.expectedLeaseEpoch, 'expectedLeaseEpoch');
    try {
      await client.claimRun(
        epoch === undefined
          ? { expectedLeaseOwner: owner }
          : { expectedLeaseOwner: owner, expectedLeaseEpoch: epoch },
      );
    } catch (err) {
      // Idempotent retry: the lease may still be held by us under a newer
      // epoch (the admission attempt's response was lost when the worker
      // died). The Engine's stale-epoch conflict carries the actual
      // owner+epoch; renew only when WE hold it.
      const stale = parseStaleLeaseDetails(err);
      if (stale && stale.leaseOwner === owner) {
        await client.claimRun({
          expectedLeaseOwner: owner,
          expectedLeaseEpoch: BigInt(stale.actualEpoch),
        });
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Never leave a partially-reconstructed client cached.
    try {
      manager.evictRun(runId);
    } catch {
      // ignore — eviction is best-effort cleanup
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      msg.startsWith(RECOVERY_FAILED_PREFIX) ? msg : `${RECOVERY_FAILED_PREFIX}${runId}:${msg}`,
    );
  }
}

async function ensureRunClient(
  manager: RunClientRecoveryManager,
  recovery: RecoveryMaterial,
): Promise<void> {
  const runId = recovery.scope.runId;
  if (hasRunClient(manager, runId)) return;
  const existing = recoveryFlights.get(runId);
  if (existing) return existing;
  const flight = (async () => {
    try {
      await recoverRunClient(manager, recovery);
    } finally {
      // Unconditional delete is safe: a replacement flight for this run can
      // only be created after this entry is gone (get() would have returned
      // it), so no other flight can be in the map here.
      recoveryFlights.delete(runId);
    }
  })();
  recoveryFlights.set(runId, flight);
  return flight;
}

/**
 * Wrap every activity so a trailing recovery envelope (see
 * `@neryva/activities` recovery.ts) reconstructs a missing run client before
 * the activity runs. The envelope is stripped before invoking the original
 * activity, so the underlying activity package signatures are unchanged.
 * Activities invoked without an envelope behave exactly as before.
 * Exported for unit tests.
 */
export function wrapActivitiesWithRecovery(
  manager: RunClientRecoveryManager,
  activities: Record<string, unknown>,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(activities)) {
    if (typeof fn !== 'function') {
      wrapped[name] = fn;
      continue;
    }
    const original = fn as (this: unknown, ...args: unknown[]) => unknown;
    wrapped[name] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const last = args[args.length - 1];
      if (isRecoveryMaterial(last)) {
        await ensureRunClient(manager, last);
        return original.apply(this, args.slice(0, -1));
      }
      return original.apply(this, args);
    };
  }
  return wrapped;
}

export function createActivityRegistry(opts: ActivityRegistryOptions): Record<string, unknown> {
  const mcp = createMcpActivities(runScopedClient(opts.manager));
  const context = createContextActivities(runScopedClient(opts.manager));
  // REL-1.5 — the model gateway resolves provider keys per call through the
  // Engine's audited GetToolCredential rail; the run-scoped client proxy
  // makes every activity call resolve the CURRENT run's capability.
  const model = createModelActivities(
    undefined,
    new EngineSecretProvider(runScopedClient(opts.manager)),
    // A2-63 — stream assistant tokens as AssistantChunk run events so the
    // Engine's SSE `delta` channel carries live tokens during generation.
    { chunkClient: runScopedClient(opts.manager), producerId: 'runtime-worker' },
  );
  const tool = createToolActivities({
    requestHandoff: async (runId: string, args: unknown) => {
      const reasonArg = (args as { reason?: unknown } | null)?.reason;
      const reason =
        typeof reasonArg === 'string' && reasonArg.trim()
          ? reasonArg
          : 'tool:request_human_handoff';
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
  const plain: Record<string, unknown> = {
    // MCP (incl. commitRunResult / failRun — terminal, idempotent)
    ...(mcp as Record<string, unknown>),
    // Context
    ...(context as Record<string, unknown>),
    // Events (durable semantic)
    emitEvent: events.emitEvent,
    emitBatch: events.emitBatch,
    // Model
    ...(model as Record<string, unknown>),
    // Tool
    ...(tool as Record<string, unknown>),
    // Approval
    ...(approval as Record<string, unknown>),
    // Memory
    ...(memory as Record<string, unknown>),
    // Usage
    ...(usage as Record<string, unknown>),
    // Artifacts
    ...(createArtifactActivities() as unknown as Record<string, unknown>),
    // Guardrails (FL-1.4)
    moderateContent: guardrails.moderateContent,
    // Checkpoints (FL-2.17)
    saveCheckpoint: checkpoints.saveCheckpoint,
    loadCheckpoint: checkpoints.loadCheckpoint,
  };
  // Wave 4 GAP 2 — run-client recovery: on a fresh worker after a crash or
  // restart, the workflow's trailing recovery envelope reconstructs the run's
  // MCP client from the dispatch capability and re-acquires/renews the Engine
  // lease before the retried activity runs. The envelope is stripped before
  // invoking the original activity; activities called without an envelope
  // behave exactly as before.
  const registry = wrapActivitiesWithRecovery(opts.manager, plain);

  // Claim is bootstrap-aware: pre-claim there is no run client yet, so the claim
  // The Engine-issued dispatch capability (relayed through the workflow input)
  // is the production path: the worker presents it as Authorization: Bearer on
  // every Engine MCP RPC, including the first one (claim/lease). The bootstrap
  // identity is only a fallback for workflows started without a dispatch
  // capability — the Engine rejects it, failing closed.
  registry['acquireOrRenewRunLease'] = async (params: {
    scope: Parameters<
      ReturnType<typeof createMcpActivities>['acquireOrRenewRunLease']
    >[0] extends infer P
      ? P extends { scope: infer S }
        ? S
        : never
      : never;
    expectedLeaseOwner?: string;
    // Temporal cannot serialize bigint, so the workflow passes a plain JSON
    // number; coerce to the uint64 bigint the protobuf client requires.
    expectedLeaseEpoch?: bigint | number;
    capabilityToken?: string;
    capabilityId?: string;
  }) => {
    const scope = params.scope as unknown as {
      organizationId: string;
      conversationId: string;
      runId: string;
      agentVersionId: string;
      actorId: string;
    };
    const client =
      params.capabilityToken && params.capabilityId
        ? opts.manager.dispatchClient(scope, params.capabilityToken, params.capabilityId)
        : opts.manager.bootstrapClient(scope);
    const claim = (expectedEpoch: bigint | undefined, expectedOwner?: string) =>
      client.claimRun({
        expectedLeaseOwner: expectedOwner ?? params.expectedLeaseOwner,
        expectedLeaseEpoch: expectedEpoch,
      });
    try {
      // Boundary: the workflow passes a plain JSON number; coerce to the
      // uint64 the protobuf client requires, rejecting unsafe values loudly.
      // Passed through untouched — toUint64 accepts both number and bigint.
      const epoch = toUint64(params.expectedLeaseEpoch, 'expectedLeaseEpoch');
      const res: unknown = await claim(epoch);
      // The dispatch client is cached per runId, so every later activity resolves
      // the same Engine-issued capability via clientForRun. (The Engine's claim
      // response carries no capability — capabilities are issued at dispatch —
      // so there is nothing to upgrade here.)
      return toSerializableClaim(res);
    } catch (err) {
      // Idempotent retry: a previous attempt may have acquired the lease while
      // its response was lost (timeout/crash). The Engine's stale-epoch
      // conflict carries the actual owner+epoch in the `details` response
      // header. If WE hold the lease, re-claim with the current epoch and our
      // owner (a renew, not a steal). Otherwise rethrow — another holder is a
      // real conflict.
      const stale = parseStaleLeaseDetails(err);
      const ourOwner = `agent-studio:${scope.actorId}`;
      if (stale && stale.leaseOwner === ourOwner) {
        return toSerializableClaim(await claim(BigInt(stale.actualEpoch), ourOwner));
      }
      throw err;
    }
  };

  return registry;
}

export type ActivityRegistry = ReturnType<typeof createActivityRegistry>;
