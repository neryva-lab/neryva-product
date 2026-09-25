/**
 * workflow-state.ts — bounded workflow state (Temporal-owned, not Engine DB)
 * Source: agent_studio_implementation_plan.md:756-770, 1118-1125, agent_studio_architecture.md:575-581, 138-139
 * Only IDs/refs/bounded metadata. Never raw prompts/docs/credentials/full provider responses.
 * Keep inputs small, references not full docs (595).
 */

import type { KernelState } from '@neryva/agent-kernel';

/**
 * Deterministic input to AgentRunWorkflow — must remain bounded.
 * All large/sensitive values are claim-check refs (artifactId) or Engine refs.
 */
export interface AgentRunWorkflowInput {
  /** Stable workflow ID derived from runId — deterministic, idempotent start (1106) */
  runId: string;
  organizationId: string;
  conversationId: string;
  agentVersionId: string;
  policySnapshotId: string;
  /**
   * Agent-level per-tool approval policy (from assistant_versions.tool_policy).
   * Maps tool name → approval requirement. The Engine populates this from the
   * published agent version so the Studio can enforce the user's builder
   * configuration (e.g., "Always" approval) at execution time.
   */
  agentApprovalPolicy?: Record<string, 'required' | 'optional' | 'none'> | undefined;
  /** Bounded: caller passes only refs, not full history. Engine owns history (main.md:114-190). */
  triggerMessageId?: string | undefined;
  /** Artifact refs for any large inline payload that exceeded threshold at admission. */
  claimCheckRefs?: string[] | undefined;
  /** Idempotency key for start — stable run_id + trigger */
  idempotencyKey: string;
  /** Generation for step-id stability (continue-as-new increments) */
  workflowGeneration: number;
  /** Correlation for tracing Engine → MCP → Temporal → provider/tool */
  correlationId: string;
  /**
   * Engine-issued run-scoped capability JWT, relayed from dispatch via
   * runtime-control. The worker presents it as Authorization: Bearer on every
   * Engine MCP RPC. Optional for backward compat with already-started
   * workflows; absent means MCP RPCs fail closed at the Engine.
   */
  capabilityToken?: string | undefined;
  /** capability_id bound to capabilityToken (request-context binding). */
  capabilityId?: string | undefined;
  /** Caller-provided budgets override — bounded */
  budgetOverrides?:
    | Partial<{
        maxModelCalls: number;
        maxToolCalls: number;
        maxTokens: number;
      }>
    | undefined;
}

/**
 * Workflow progress carried in Continue-As-New.
 * Only refs + counters + small checkpoint metadata (575-581).
 */
export interface WorkflowProgress {
  kernelState: KernelState;
  /** Number of history events approximated (for CAN threshold, not hard-coded count) */
  historyEventCount: number;
  /** Total payload bytes seen in workflow args/results (for bounded check) */
  payloadBytes: number;
  /** Last checkpoint artifact ref */
  checkpointRef?: string | undefined;
  /** Signals drained at last safe point */
  pendingSignals: QueuedSignal[];
  /** Whether cancellation was requested */
  cancellationRequested?: boolean | undefined;
  cancellationReason?: string | undefined;
}

export interface QueuedSignal {
  signalId: string;
  kind: 'CANCEL' | 'APPROVAL' | 'USER_INPUT';
  payloadRef?: string | undefined;
  receivedAtMs: number;
  /** For approval: one-time ID correlated to tool_call_id/step_id (1116) */
  approvalId?: string | undefined;
  toolCallId?: string | undefined;
  decision?: 'APPROVED' | 'DENIED' | undefined;
}

export interface WorkflowDiagnostics {
  runId: string;
  organizationId: string;
  conversationId: string;
  status: string;
  modelCalls: number;
  toolCalls: number;
  turns: number;
  isTerminal: boolean;
  hasPendingApproval: boolean;
  cancellationRequested: boolean;
}

export function deriveWorkflowId(runId: string): string {
  // Deterministic: one workflow per run_id, no duplicate workflow (1106)
  // Engine creates run_id (UUIDv7), Studio uses fixed prefix
  return `agent-run::${runId}`;
}

export function isWorkflowInputBounded(input: AgentRunWorkflowInput): boolean {
  // Must remain small — large content via claim-check (595)
  // Rough bound: serialized input < MAX_INLINE_BYTES * 2
  // Actual enforcement via bytes, not string length, but heuristic here
  const serialized = JSON.stringify(input);
  return serialized.length <= 16_384; // 16KB workflow input bound
}
