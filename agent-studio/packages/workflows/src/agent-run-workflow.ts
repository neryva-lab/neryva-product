/**
 * agent-run-workflow.ts — deterministic AgentRunWorkflow
 * Source: agent_studio_implementation_plan.md:289-305, 798-812, 137-143, 1102-1117
 * Deterministic orchestration only: validate, call Activities with explicit timeout/retry,
 * track budgets, wait on Signals for approval/cancellation/user-input, Continue-As-New on measured growth.
 * NO provider SDK / MCP network / env access / Date / Math.random / network fetch inside — via Activities & Temporal APIs.
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  continueAsNew,
  log,
  patched,
} from '@temporalio/workflow';
import type { AgentRunWorkflowInput, WorkflowProgress, QueuedSignal } from './workflow-state.js';
import { deriveWorkflowId } from './workflow-state.js';
import {
  RECOVERY_FAILED_PREFIX,
  type RecoveryMaterial,
  type WithRecovery,
} from './recovery-material.js';

import { assertWorkflowInputBounded } from './payload.js';
import { extractVersionNumber, isTemporalJsonSafe } from './version-extract.js';
import { classifyTerminalFailure } from './terminal-failure.js';
import { ApprovalIdMap } from './approval-ids.js';
import { buildToolCallCompletedEmit, buildToolCallEmit } from './tool-call-events.js';
import { shouldContinueAsNew, incrementHistoryCount } from './continue-as-new.js';
import { PATCH_IDS } from './workflow-versioning.js';
import type { EventType, RuntimeEventBody } from '@neryva/contracts/events/runtime-events';
import type { NeryvaModelResponse } from '@neryva/contracts/provider/model-response';
import type { NeryvaTool } from '@neryva/contracts/provider/model-request';

// Activity interfaces — types only, implementations are in @neryva/activities (never provider SDK in workflow)
type McpActivities = {
  acquireOrRenewRunLease(params: {
    /** Engine-granted scope for this run — from bounded workflow input, never model output */
    scope: {
      organizationId: string;
      conversationId: string;
      runId: string;
      agentVersionId: string;
      actorId: string;
    };
    expectedLeaseOwner?: string;
    expectedLeaseEpoch?: number;
  }): Promise<unknown>;
  commitRunResult(params: {
    resultText: string;
    expectedVersion?: number;
    usage?: {
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    suggestedFollowups?: string[];
  }): Promise<unknown>;
  failRun(params: { errorCode: string; errorMessage: string }): Promise<unknown>;
  releaseRunLease(epoch: number): Promise<unknown>;
};

type ContextActivities = {
  compileContext(params: {
    runId: string;
    organizationId: string;
    conversationId: string;
    agentVersionId: string;
    triggerMessageId?: string;
  }): Promise<{
    runId: string;
    organizationId: string;
    agentVersionId: string;
    messages: Array<{ role: string; content: ModelMessageContent }>;
    tools: Array<{
      name: string;
      version: string;
      effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
      approvalRequirement: 'NONE' | 'REQUIRED';
      description?: string | undefined;
      inputSchema?: Record<string, unknown> | undefined;
    }>;
    budgets: {
      maxModelCalls: number;
      maxToolCalls: number;
      maxTurns: number;
      maxTotalTokens: number;
      wallClockSeconds: number;
    };
    citationRefs?: string[];
    modelParams?: {
      temperature?: number;
      maxOutputTokens?: number;
      topP?: number;
      reasoningEffort?: string;
    };
    allowedModels?: string[];
    guardrailPolicy: { input_policy: string; output_policy: string };
    triggerAttachments: Array<{
      artifactId: string;
      mediaType: string;
      byteLength: number;
      sha256?: Uint8Array;
    }>;
  }>;
  fetchRunImages(params: {
    attachments: Array<{
      artifactId: string;
      mediaType: string;
      byteLength: number;
      sha256?: Uint8Array;
    }>;
  }): Promise<Array<{ artifactId: string; mediaType: string; dataBase64: string }>>;
};

type EventActivities = {
  emitEvent(params: {
    scope: {
      organizationId: string;
      conversationId: string;
      runId: string;
      correlationId: string;
    };
    type: EventType;
    stepId?: string | undefined;
    body: RuntimeEventBody;
    artifactContent?: Uint8Array | undefined;
    redaction?: 'NONE' | 'PII' | 'SECRET' | undefined;
  }): Promise<{ eventId: string; idempotencyKey: string; wasArtifact: boolean }>;
};

/**
 * FL-1.6 — multimodal content: text-only string or content parts.
 * Tool turns use AI SDK v4 CoreMessage parts: the gateway passes `messages`
 * straight to `generateText`, which validates every message against
 * `coreMessageSchema` ("message must be a CoreMessage"). In particular a
 * `{ role: 'tool', content: <string> }` message is REJECTED — tool results
 * must be `tool-result` parts, and assistant tool proposals must be
 * `tool-call` parts, or every model call after the first tool turn fails
 * prompt validation. (The legacy `image` part shape is Studio-internal and
 * is normalized by the gateway before reaching the SDK.)
 */
type ModelMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; mediaType: string; data: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
      | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
    >;

/**
 * Bound a tool result for prompt inclusion. Tool results are JSON values;
 * an unbounded result would blow up the prompt, so values whose serialized
 * form exceeds the budget degrade to a truncated preview (deterministic —
 * JSON.stringify with the same input always yields the same output).
 */
const MAX_TOOL_RESULT_JSON_CHARS = 4096;
function boundToolResult(result: unknown): unknown {
  let json: string;
  try {
    // JSON.stringify returns undefined for undefined input, but the TS lib
    // types claim `string` — so the ?? below looks unnecessary to the
    // linter while being load-bearing at runtime.
    const serialized: string | undefined = JSON.stringify(result);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    json = serialized ?? 'null';
  } catch {
    return '[unserializable tool result]';
  }
  if (json.length <= MAX_TOOL_RESULT_JSON_CHARS) return result;
  return `${json.slice(0, MAX_TOOL_RESULT_JSON_CHARS)}…[truncated]`;
}

/** Minimal tool-call shape the workflow accumulates from a model turn. */
export interface WorkflowToolCall {
  id: string;
  name: string;
  args?: unknown;
}

/** One executed tool outcome bound back to its proposal. */
export interface WorkflowToolOutcome {
  tool_call_id: string;
  tool: string;
  status: 'EXECUTED' | 'DENIED' | 'FAILED';
  result: unknown;
}

/**
 * Build the assistant history message for a model turn. Tool proposals become
 * AI SDK CoreMessage `tool-call` parts (with an optional leading text part) —
 * never a JSON string. Pure and deterministic; covered by
 * core-message-parts.test.ts against the real AI SDK `coreMessageSchema`.
 */
export function buildAssistantHistoryMessage(
  text: string | undefined,
  toolCalls: WorkflowToolCall[] | undefined,
): { role: string; content: ModelMessageContent } {
  if (toolCalls && toolCalls.length > 0) {
    const parts: Array<
      | { type: 'text'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
    > = [];
    if (text) parts.push({ type: 'text', text });
    for (const tc of toolCalls) {
      parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, args: tc.args });
    }
    return { role: 'assistant', content: parts };
  }
  return { role: 'assistant', content: text ?? '' };
}

/**
 * Build the single tool-result history message for a turn. Every outcome
 * becomes an AI SDK CoreMessage `tool-result` part — `{ role: 'tool',
 * content: <string> }` is not a valid CoreMessage and makes the next
 * `generateText` call reject the whole prompt ("message must be a
 * CoreMessage"). Pure and deterministic; covered by
 * core-message-parts.test.ts against the real AI SDK `coreMessageSchema`.
 */
export function buildToolResultHistoryMessage(
  outcomes: WorkflowToolOutcome[],
): { role: string; content: ModelMessageContent } {
  return {
    role: 'tool',
    content: outcomes.map((e) => ({
      type: 'tool-result' as const,
      toolCallId: e.tool_call_id,
      toolName: e.tool,
      result: boundToolResult(e.result),
      ...(e.status === 'EXECUTED' ? {} : { isError: true as const }),
    })),
  };
}

type ModelActivities = {
  callModel(params: {
    runId: string;
    stepId: string;
    organizationId: string;
    conversationId?: string;
    agentVersionId: string;
    messages: Array<{ role: string; content: ModelMessageContent }>;
    tools?: NeryvaTool[];
    correlationId?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  }): Promise<
    NeryvaModelResponse & {
      stepId: string;
    }
  >;
};

type ToolActivities = {
  executeTool(params: {
    runId: string;
    organizationId: string;
    stepId: string;
    toolName: string;
    toolVersion: string;
    args: unknown;
    idempotencyKey: string;
    effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
    approvalId?: string;
  }): Promise<{
    toolCallId: string;
    stepId: string;
    success: boolean;
    result?: unknown;
    outcome?: string;
  }>;
};

type ApprovalActivities = {
  createApprovalRequest(params: {
    approvalId: string;
    runId: string;
    organizationId: string;
    toolCallId: string;
    stepId: string;
    toolName: string;
  }): Promise<{ approvalId: string }>;
  /**
   * Durable read of the Engine's approval decision (GetApprovalState).
   * The workflow polls this while parked on an approval-required call —
   * see waitForApprovalDecision.
   */
  getApprovalState(params: { approvalRef: string }): Promise<{ state?: string }>;
  /**
   * Refresh the Engine's current run version after an external version bump
   * (approval decision WAITING_APPROVAL → RUNNING increments runs.version).
   * The returned version replaces the admission-time CAS token for all later
   * version-guarded activities (commitRunResult).
   */
  getRunVersion(): Promise<{ version: unknown }>;
};

type GuardrailActivities = {
  moderateContent(params: {
    runId: string;
    content: string;
    direction: 'input' | 'output';
    policy: { input_policy?: string; output_policy?: string };
  }): Promise<{ blocked: boolean; verdict: string; categories: string[]; provider: string }>;
};

type CheckpointActivities = {
  saveCheckpoint(params: {
    runId: string;
    organizationId: string;
    state: {
      messages: Array<{ role: string; content: ModelMessageContent }>;
      turn: number;
      totalPrompt: number;
      totalCompletion: number;
      toolCallsExecuted: number;
    };
  }): Promise<boolean>;
  loadCheckpoint(): Promise<{
    messages: Array<{ role: string; content: ModelMessageContent }>;
    turn: number;
    totalPrompt: number;
    totalCompletion: number;
    toolCallsExecuted: number;
  } | null>;
};

// Signals & queries — single source of truth (also exported from signals.ts)
const cancelSignal =
  defineSignal<[{ reason: string; requestedBy: string; requestedAt: string }]>('CancelRun');
const approvalSignal = defineSignal<
  [
    {
      approvalId: string;
      toolCallId: string;
      stepId: string;
      decision: 'APPROVED' | 'DENIED';
      correlationId: string;
      decidedBy: string;
      decidedAt: string;
    },
  ]
>('ApprovalDecision');
const userInputSignal =
  defineSignal<[{ signalId: string; text?: string; inputRef?: string }]>('UserInput');

const getProgressQuery = defineQuery<WorkflowProgress | undefined>('getProgress');
const getDiagnosticsQuery = defineQuery<
  | { runId: string; status: string; modelCalls: number; toolCalls: number; cancelled: boolean }
  | undefined
>('getDiagnostics');

// Proxy activities with explicit per-class timeouts/retries (no blanket retry)
const {
  acquireOrRenewRunLease,
  commitRunResult,
  failRun,
  releaseRunLease: _releaseRunLease,
} = proxyActivities<
  WithRecovery<Omit<McpActivities, 'acquireOrRenewRunLease'>> &
    Pick<McpActivities, 'acquireOrRenewRunLease'>
>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '15s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'CAPABILITY_DENIED', 'TERMINAL_RUN'],
  },
});

const { compileContext, fetchRunImages } = proxyActivities<WithRecovery<ContextActivities>>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '20s',
  retry: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'UNAUTHORIZED_CONTEXT'],
  },
});

const { emitEvent } = proxyActivities<WithRecovery<EventActivities>>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '15s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'CAPABILITY_DENIED'],
  },
});

const { callModel } = proxyActivities<WithRecovery<ModelActivities>>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '60s',
  heartbeatTimeout: '20s',
  retry: {
    maximumAttempts: 2,
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    nonRetryableErrorTypes: ['PROVIDER_AUTH_FAILED', 'INVALID_REQUEST', 'BUDGET_EXHAUSTED'],
  },
});

const { executeTool } = proxyActivities<WithRecovery<ToolActivities>>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '45s',
  heartbeatTimeout: '15s',
  retry: {
    // effectful tools: exactly-once via stable idempotency key + downstream dedup;
    // Temporal retries only READ_ONLY here — effectful failures surface UNKNOWN_OUTCOME.
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['POLICY_DENIED', 'TOOL_NOT_FOUND', 'APPROVAL_DENIED'],
  },
});

const { createApprovalRequest, getApprovalState, getRunVersion } = proxyActivities<
  WithRecovery<ApprovalActivities>
>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '15s',
  retry: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['APPROVAL_ALREADY_DECIDED'],
  },
});

const { moderateContent, saveCheckpoint, loadCheckpoint } = proxyActivities<
  WithRecovery<CheckpointActivities> & GuardrailActivities
>({
  scheduleToStartTimeout: '10s',
  startToCloseTimeout: '15s',
  retry: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: [],
  },
});

// Suppress unused-proxy lint — releaseRunLease is invoked via the finally block below
void _releaseRunLease;

/** FL-1.6 — flatten multimodal content to text (image parts dropped). */
function messageToText(content: ModelMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Bounded budget limits for one run — resolved from definition, overridable by caller input. */
interface ResolvedBudgets {
  maxModelCalls: number;
  maxToolCalls: number;
  maxTurns: number;
  maxTokens: number;
}

/**
 * AgentRunWorkflow — deterministic orchestration.
 * Input is bounded refs only (payload.ts). Workflow owns orchestration + budgets + CAN + signals.
 * Engine owns canonical history via emitEvent/CommitRunResult (idempotent).
 */
export async function agentRunWorkflow(input: AgentRunWorkflowInput): Promise<string> {
  // 1. Fail-closed validation — deterministic, no network
  assertWorkflowInputBounded(input);
  const expectedWorkflowId = deriveWorkflowId(input.runId);
  const info = workflowInfo();
  if (info.workflowId !== expectedWorkflowId) {
    log.warn(
      `workflowId mismatch: got ${info.workflowId}, expected ${expectedWorkflowId} — still proceeding, admission will verify lease`,
    );
  }

  // 2. Version marker — keep compat with future patches
  if (patched(PATCH_IDS.CONTINUE_AS_NEW_V2)) {
    log.info('patched CONTINUE_AS_NEW_V2 active');
  }

  // 3. State — bounded kernel-state-like progress (no full history)
  let progress: WorkflowProgress = {
    kernelState: {
      runId: input.runId,
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      agentVersionId: input.agentVersionId,
      policyVersionId: input.policySnapshotId,
      status: 'ADMISSION',
      stepId: `${input.runId}#${input.workflowGeneration}#admission`,
      attempt: 1,
      budgets: { modelCalls: 0, toolCalls: 0, tokens: 0, costCents: 0, recursionDepth: 0 },
      loopCounters: { modelCalls: 0, toolCalls: 0, turns: 0 },
      artifactRefs: [],
      terminalIntent: undefined,
      cancelled: false,
    },
    historyEventCount: 1,
    payloadBytes: JSON.stringify(input).length,
    pendingSignals: [],
    cancellationRequested: false,
  };

  const pendingApprovals = new Map<
    string,
    QueuedSignal & { resolve: (v: QueuedSignal) => void; promise: Promise<QueuedSignal> }
  >();
  let cancelRequested: { reason: string; requestedBy: string } | undefined = undefined;
  // Deterministic logical clock — increments on each bump, never wall-clock (forbidden Date.now in workflow)
  let logicalClock = 0;
  const startClock = 0;

  // 4. Signal handlers — durable, survive restart, drain at safe points (1102-1117)
  setHandler(cancelSignal, (payload) => {
    if (!cancelRequested) {
      cancelRequested = { reason: payload.reason, requestedBy: payload.requestedBy };
      progress.cancellationRequested = true;
      progress.cancellationReason = payload.reason;
      logicalClock += 1;
      progress.pendingSignals.push({
        signalId: `cancel_${logicalClock}`,
        kind: 'CANCEL',
        receivedAtMs: logicalClock,
      });
      log.info(`CancelRun signal received: ${payload.reason} by ${payload.requestedBy}`);
    }
  });

  setHandler(approvalSignal, (payload) => {
    logicalClock += 1;
    const queued: QueuedSignal = {
      signalId: payload.approvalId,
      kind: 'APPROVAL',
      approvalId: payload.approvalId,
      toolCallId: payload.toolCallId,
      decision: payload.decision,
      receivedAtMs: logicalClock,
    };
    const pending = pendingApprovals.get(payload.approvalId);
    if (pending) {
      pending.resolve(queued);
      // Consume once — drain removes from pendingSignals so a replay/CAN cannot double-apply
      progress.pendingSignals = progress.pendingSignals.filter(
        (s) => s.approvalId !== payload.approvalId,
      );
    } else {
      progress.pendingSignals.push(queued);
    }
    log.info(`ApprovalDecision signal: ${payload.approvalId} ${payload.decision}`);
  });

  setHandler(userInputSignal, (payload) => {
    logicalClock += 1;
    progress.pendingSignals.push({
      signalId: payload.signalId,
      kind: 'USER_INPUT',
      payloadRef: payload.inputRef ?? payload.text,
      receivedAtMs: logicalClock,
    });
    log.info(`UserInput signal: ${payload.signalId}`);
  });

  setHandler(getProgressQuery, () => progress);
  setHandler(getDiagnosticsQuery, () => ({
    runId: input.runId,
    status: progress.kernelState.status,
    modelCalls: progress.kernelState.loopCounters.modelCalls,
    toolCalls: progress.kernelState.loopCounters.toolCalls,
    cancelled: !!progress.cancellationRequested,
  }));

  // Helper: drain cancel at safe point
  function checkCancellation(): void {
    const cr = cancelRequested as { reason: string } | undefined;
    if (cr !== undefined || progress.cancellationRequested) {
      throw new Error(`CANCELLED:${cr?.reason ?? progress.cancellationReason ?? 'unknown'}`);
    }
  }

  // Helper: bounded history increment — deterministic logical clock, not wall-clock.
  // Continue-As-New is DEFERRED while signals are pending: unconsumed signals are lost
  // across a CAN generation, so drain them first (safe point rule 1102-1117).
  function bumpHistory(delta: number, bytes: number): void {
    logicalClock += 1;
    progress = incrementHistoryCount(progress, delta, bytes);
    const elapsed = logicalClock - startClock; // logical steps, not wall-clock ms
    if (progress.pendingSignals.length > 0) return; // defer CAN — drain first
    const decision = shouldContinueAsNew(progress, elapsed);
    if (decision.shouldContinueAsNew) {
      log.info(`ContinueAsNew trigger: ${decision.reason}`);
      throw new Error(`CONTINUE_AS_NEW:${decision.reason}`);
    }
  }

  // Lease epoch + business run version from the Engine claim — the epoch
  // fences lease release; the version is the CAS token for the terminal
  // commit. Both travel through Temporal activity args, so they MUST stay
  // plain JSON numbers (see version-extract.ts): the default payload
  // converter cannot serialize bigint, and scheduling an activity with a
  // bigint arg fails INSIDE the workflow (scheduleActivityNextHandler →
  // toPayloadsWithContext) before the activity ever runs. The MCP boundary
  // needs uint64, so the activity layer converts back to bigint at its own
  // edge (toUint64 in @neryva/activities).
  let leaseEpoch = 0;
  let expectedRunVersion = 0;

  /**
   * Wave 4 GAP 2 — recovery envelope attached as the trailing argument of
   * every MCP-dependent activity call. On a fresh worker after a crash or
   * restart, the activity registry uses it to reconstruct the run's MCP
   * client (from the Engine-issued dispatch capability) and re-acquire/renew
   * the lease before the retried activity runs. Built from workflow input +
   * deterministic workflow state only (replay-safe, plain JSON).
   */
  const recoveryMaterial = (): RecoveryMaterial => ({
    __neryvaRecovery: true,
    scope: {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      runId: input.runId,
      agentVersionId: input.agentVersionId,
      actorId: `run:${input.runId}`,
    },
    ...(input.capabilityToken !== undefined ? { capabilityToken: input.capabilityToken } : {}),
    ...(input.capabilityId !== undefined ? { capabilityId: input.capabilityId } : {}),
    ...(leaseEpoch > 0 ? { expectedLeaseEpoch: leaseEpoch } : {}),
  });

  /**
   * Durable wait for ONE approval decision — survives restart, cancel
   * propagates Engine→Studio→Temporal→tool. Used by the multi-call approval
   * path (FL-1.1 lockstep): one wait per approval-required call.
   *
   * REL-11.4 fix (Wave 4 smoke): the Engine never delivers the
   * ApprovalDecision Temporal signal — no component calls DeliverRunInput,
   * and runtime-control's deliverRunInput signals 'DeliverRunInput', which no
   * workflow handles — so a signal-only wait never resolves and an approved
   * run stays parked until the 30-day bound. The wait now ALSO polls the
   * Engine's durable decision via GetApprovalState: the same source the
   * inline executor already uses (apps/runtime-control/src/inline-executor.ts)
   * and the behaviour the Engine's run-dispatch consumer documents ("the
   * fresh executor observes the durable decision via GetApprovalState").
   * EXPIRED is treated as a denial: the side effect must not execute after
   * its decision window closes.
   */
  async function waitForApprovalDecision(approvalId: string): Promise<QueuedSignal | undefined> {
    const drained = progress.pendingSignals.find(
      (s) => s.approvalId === approvalId && s.kind === 'APPROVAL',
    );
    if (drained) {
      // Drain: consume from pending so a replay/CAN cannot double-apply
      progress.pendingSignals = progress.pendingSignals.filter((s) => s.approvalId !== approvalId);
      return drained;
    }
    const pendingEntry = { signalId: approvalId } as QueuedSignal;
    let resolver!: (v: QueuedSignal) => void;
    const promise = new Promise<QueuedSignal>((resolve) => {
      resolver = resolve;
    });
    pendingApprovals.set(approvalId, {
      ...pendingEntry,
      resolve: resolver,
      promise,
    } as never);
    const settleFromPoll = (decision: 'APPROVED' | 'DENIED'): void => {
      const pending = pendingApprovals.get(approvalId);
      if (!pending) return; // already settled — signal won, cancelled, or timed out
      pendingApprovals.delete(approvalId);
      logicalClock += 1;
      pending.resolve({
        signalId: approvalId,
        kind: 'APPROVAL',
        approvalId,
        decision,
        receivedAtMs: logicalClock,
      } as QueuedSignal);
    };
    // Durable poll of the Engine decision. Detached (not awaited): the race
    // below owns the wait's lifetime; the loop exits on its own once the
    // entry is settled (the condition wakes it). Never awaited after the
    // race — that would block on an in-flight activity after the wait
    // already resolved.
    const poll = (async (): Promise<void> => {
      while (pendingApprovals.has(approvalId) && !cancelRequested) {
        let state: string;
        try {
          const res = await getApprovalState({ approvalRef: approvalId }, recoveryMaterial());
          state = res.state ?? 'NOT_FOUND';
        } catch {
          state = 'NOT_FOUND'; // transient MCP failure — retry next tick
        }
        if (state === 'APPROVED') {
          settleFromPoll('APPROVED');
          return;
        }
        if (state === 'DENIED' || state === 'EXPIRED') {
          settleFromPoll('DENIED');
          return;
        }
        // Cancellable sleep — wakes early when the entry settles.
        await condition(() => !pendingApprovals.has(approvalId) || !!cancelRequested, '10s');
      }
    })();
    // Race between approval (signal or durable poll) and cancellation —
    // 30-day durable timer bound
    const arrived = await Promise.race([
      promise,
      condition(() => !!cancelRequested, '30 days').then(
        () => undefined as unknown as QueuedSignal,
      ),
    ]);
    pendingApprovals.delete(approvalId);
    void poll;
    return arrived as QueuedSignal | undefined;
  }

  // 5. Orchestration — try/catch ensures terminal commit/fail is idempotent, crash-safe
  try {
    checkCancellation();

    // ADMISSION: claim lease — deterministic WorkflowId ensures no duplicate (1106), Engine lease enforces one active run per conv (main.md:377)
    progress.kernelState.status = 'ADMISSION';
    const claimRes = await acquireOrRenewRunLease({
      scope: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        runId: input.runId,
        agentVersionId: input.agentVersionId,
        actorId: `run:${input.runId}`,
      },
      // Engine-issued capability relayed from dispatch — the worker needs it
      // to authorize this and every later Engine MCP RPC.
      ...(input.capabilityToken !== undefined ? { capabilityToken: input.capabilityToken } : {}),
      ...(input.capabilityId !== undefined ? { capabilityId: input.capabilityId } : {}),
    });
    leaseEpoch = extractVersionNumber(claimRes, 'leaseEpoch', 'epoch');
    expectedRunVersion = extractVersionNumber(claimRes, 'version', 'runVersion');
    // Invariant: these cross Temporal activity args — fail here with a precise
    // message rather than inside the scheduler with a cryptic converter error.
    if (!isTemporalJsonSafe({ leaseEpoch, expectedRunVersion })) {
      throw new Error(
        'NON_SERIALIZABLE_VERSION: lease epoch / run version must be plain JSON numbers',
      );
    }
    bumpHistory(2, 256);
    progress.kernelState.status = 'LOAD_CONTEXT';
    log.info(`ADMISSION ok for ${input.runId}`);

    // LOAD_CONTEXT + POLICY_CHECK via compileContext (MCP-backed, deterministic ordering later)
    const compiled = await compileContext(
      {
        runId: input.runId,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        agentVersionId: input.agentVersionId,
        ...(input.triggerMessageId !== undefined
          ? { triggerMessageId: input.triggerMessageId }
          : {}),
      },
      recoveryMaterial(),
    );
    bumpHistory(3, JSON.stringify(compiled).length);
    progress.kernelState.status = 'POLICY_CHECK';
    // Policy check: allowlist + effect classes already resolved by compileContext via MCP scope

    // FL-1.4 — user input screening at run start. A block fails the run
    // GUARDRAIL_BLOCKED before any model call (failRun is idempotent).
    const lastUserMessage = messageToText(
      [...compiled.messages].reverse().find((m) => m.role === 'user')?.content ?? '',
    );
    const inputScreening = await moderateContent({
      runId: input.runId,
      content: lastUserMessage,
      direction: 'input',
      policy: compiled.guardrailPolicy,
    });
    if (inputScreening.blocked) {
      await emitEvent(
        {
          scope: {
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            runId: input.runId,
            correlationId: input.correlationId,
          },
          type: 'RunWarning',
          body: {
            kind: 'RunWarning',
            runId: input.runId,
            code: 'GUARDRAIL_BLOCKED_INPUT',
            messageHash: `moderation categories: ${inputScreening.categories.join(',')}`,
          },
        },
        recoveryMaterial(),
      ).catch(() => {});
      await failRun(
        {
          errorCode: 'GUARDRAIL_BLOCKED',
          errorMessage: 'user input blocked by guardrail policy',
        },
        recoveryMaterial(),
      );
      return 'blocked by guardrail policy';
    }
    progress.kernelState.status = 'MODEL_STEP';

    // Budgets — from definition via compileContext, caller overrides bounded to lower or equal
    const budgets: ResolvedBudgets = {
      maxModelCalls: Math.min(
        compiled.budgets.maxModelCalls,
        input.budgetOverrides?.maxModelCalls ?? compiled.budgets.maxModelCalls,
      ),
      maxToolCalls: Math.min(
        compiled.budgets.maxToolCalls,
        input.budgetOverrides?.maxToolCalls ?? compiled.budgets.maxToolCalls,
      ),
      maxTurns: compiled.budgets.maxTurns,
      maxTokens: Math.min(
        compiled.budgets.maxTotalTokens,
        input.budgetOverrides?.maxTokens ?? compiled.budgets.maxTotalTokens,
      ),
    };
    // Wall-clock deadline (FL-1.2, lockstep with the inline executor): a
    // durable Temporal timer flips the flag — deterministic, no Date.now in
    // the workflow. 0 disables the wall-clock dimension. The flag lives on a
    // holder object so the workflow's narrowing stays sound across the timer
    // callback.
    const wallClock = { exceeded: false };
    if (compiled.budgets.wallClockSeconds > 0) {
      void condition(() => false, compiled.budgets.wallClockSeconds * 1000).then(() => {
        wallClock.exceeded = true;
      });
    }
    let tokensUsed = 0;
    const usedTokens = { prompt: 0, completion: 0 };

    // Conversation-so-far — starts from compiled context; tool results accumulate so the
    // model sees its own tool outcomes on the next turn (bounded by budgets).
    const messages: Array<{ role: string; content: ModelMessageContent }> = [...compiled.messages];

    const toolByName = new Map(compiled.tools.map((t) => [t.name, t]));

    // FL-1.6 — vision input: claim-check fetch + multimodal parts on the
    // last user message. Rejected attachments drop silently (activity logs);
    // a text-only conversation passes through untouched.
    const fetchedImages = await fetchRunImages(
      { attachments: compiled.triggerAttachments },
      recoveryMaterial(),
    );
    if (fetchedImages.length > 0) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      const target = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
      if (target) {
        const textContent = typeof target.content === 'string' ? target.content : '';
        const updated: { role: string; content: ModelMessageContent } = {
          role: target.role,
          content: [
            ...(textContent ? [{ type: 'text' as const, text: textContent }] : []),
            ...fetchedImages.map((img) => ({
              type: 'image' as const,
              mediaType: img.mediaType,
              data: img.dataBase64,
            })),
          ],
        };
        messages[lastUserIdx] = updated;
      }
    }

    const MAX_TURNS = budgets.maxTurns;
    let turns = 0;
    // FL-2.17 - resume-from-checkpoint (lockstep with the inline executor).
    const resume = await loadCheckpoint(recoveryMaterial());
    if (resume && Array.isArray(resume.messages) && resume.messages.length > 0) {
      messages.splice(0, messages.length, ...resume.messages);
      tokensUsed = resume.totalPrompt + resume.totalCompletion;
      usedTokens.prompt = resume.totalPrompt;
      usedTokens.completion = resume.totalCompletion;
      progress.kernelState.loopCounters.toolCalls = resume.toolCallsExecuted;
      turns = Math.min(resume.turn, MAX_TURNS - 1);
    }

    while (turns < MAX_TURNS) {
      checkCancellation();
      turns += 1;
      progress.kernelState.loopCounters.turns += 1;

      // MODEL_STEP — Activity, heartbeat, bounded retry (never blindly retry effectful)
      const currentStepId = `${input.runId}#${input.workflowGeneration}#model/${turns}`;
      progress.kernelState.stepId = currentStepId;
      const modelRes = await callModel(
        {
          runId: input.runId,
          stepId: currentStepId,
          organizationId: input.organizationId,
          // A2-63 — chunk event scope for AssistantChunk emission during streaming.
          conversationId: input.conversationId,
          agentVersionId: input.agentVersionId,
          messages,
          // Engine-pinned schemas from the tool catalog (context v1.1) — the
          // model cannot emit a valid call without them.
          tools: compiled.tools.map((t) => ({
            name: t.name,
            description: t.description ?? t.name,
            parameters: t.inputSchema ?? {},
          })),
          correlationId: input.correlationId,
          ...(compiled.allowedModels && compiled.allowedModels.length > 0
            ? { model: compiled.allowedModels[0] }
            : {}),
          ...(compiled.modelParams?.temperature !== undefined
            ? { temperature: compiled.modelParams.temperature }
            : {}),
          ...(compiled.modelParams?.topP !== undefined ? { topP: compiled.modelParams.topP } : {}),
          ...(compiled.modelParams?.maxOutputTokens !== undefined
            ? { maxTokens: compiled.modelParams.maxOutputTokens }
            : {}),
        },
        recoveryMaterial(),
      );
      bumpHistory(2, JSON.stringify(modelRes).length);
      progress.kernelState.loopCounters.modelCalls += 1;
      tokensUsed += modelRes.usage.totalTokens;
      usedTokens.prompt += modelRes.usage.promptTokens;
      usedTokens.completion += modelRes.usage.completionTokens;

      // Budget checks — deterministic, from definition budgets (not hard-coded)
      if (progress.kernelState.loopCounters.modelCalls > budgets.maxModelCalls) {
        throw new Error('BUDGET_EXHAUSTED:maxModelCalls');
      }
      if (tokensUsed > budgets.maxTokens) {
        throw new Error('BUDGET_EXHAUSTED:maxTokens');
      }
      if (wallClock.exceeded) {
        throw new Error('BUDGET_EXHAUSTED:wallClock');
      }

      // Emit runtime event (durable) after outcome known, stable event_id
      await emitEvent(
        {
          scope: {
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            runId: input.runId,
            correlationId: input.correlationId,
          },
          type: 'ModelCallCompleted',
          stepId: currentStepId,
          body: {
            kind: 'ModelCallCompleted',
            runId: input.runId,
            modelId: modelRes.model,
            stepId: currentStepId,
            usage: modelRes.usage,
          },
        },
        recoveryMaterial(),
      );
      bumpHistory(1, 128);

      // Accumulate the assistant turn so the next call has full conversation state
      // (CoreMessage parts — see buildAssistantHistoryMessage).
      messages.push(
        buildAssistantHistoryMessage(
          modelRes.text,
          modelRes.finishReason === 'tool-call' ? modelRes.toolCalls : undefined,
        ),
      );

      // Cancellation drains here — safe point before interpreting
      {
        const cr = cancelRequested as { reason: string } | undefined;
        if (cr !== undefined) throw new Error(`CANCELLED:${cr.reason}`);
      }

      // INTERPRET
      if (modelRes.finishReason === 'stop') {
        const text = modelRes.text ?? '';
        // FL-1.4 — assistant output screening before the terminal commit.
        const outputScreening = await moderateContent({
          runId: input.runId,
          content: text,
          direction: 'output',
          policy: compiled.guardrailPolicy,
        });
        if (outputScreening.blocked) {
          await emitEvent(
            {
              scope: {
                organizationId: input.organizationId,
                conversationId: input.conversationId,
                runId: input.runId,
                correlationId: input.correlationId,
              },
              type: 'RunWarning',
              body: {
                kind: 'RunWarning',
                runId: input.runId,
                code: 'GUARDRAIL_BLOCKED_OUTPUT',
                messageHash: `moderation categories: ${outputScreening.categories.join(',')}`,
              },
            },
            recoveryMaterial(),
          ).catch(() => {});
          await failRun(
            {
              errorCode: 'GUARDRAIL_BLOCKED',
              errorMessage: 'assistant output blocked by guardrail policy',
            },
            recoveryMaterial(),
          );
          progress.kernelState.status = 'FAILED';
          return 'blocked by guardrail policy';
        }
        progress.kernelState.status = 'FINALIZE';
        // FL-3.4 lockstep — follow-up generation rides the inline executor
        // (the operative path); the deterministic workflow stays a single
        // structured call and surfaces followups only if a re-drive supplies
        // them, so the commit interface is identical on both paths.
        const followups: string[] = [];
        // Cost catalog keys models bare ('gpt-4o-mini'), not as routed ids
        // ('openai/gpt-4o-mini'); providerId is the billing provider ('openai').
        const slash = modelRes.model.lastIndexOf('/');
        const catalogModel = slash >= 0 ? modelRes.model.slice(slash + 1) : modelRes.model;
        // FINALIZE → COMMIT_RESULT idempotent via stable idempotencyKey (1406, epoch fencing 448-449)
        // Retry-safe: duplicate CommitRunResult returns original, never duplicates assistant message
        await commitRunResult(
          {
            resultText: text,
            expectedVersion: expectedRunVersion,
            usage: {
              provider: modelRes.providerId,
              model: catalogModel,
              promptTokens: usedTokens.prompt,
              completionTokens: usedTokens.completion,
              totalTokens: usedTokens.prompt + usedTokens.completion,
            },
            ...(followups.length > 0 ? { suggestedFollowups: followups } : {}),
          },
          recoveryMaterial(),
        );
        bumpHistory(2, text.length);
        progress.kernelState.status = 'COMMIT_RESULT';
        // No separate RunCompleted emit: the Engine writes the terminal
        // `run.completed` run-event atomically with the COMPLETED transition
        // inside commitRunResult (it owns the run lifecycle). A post-terminal
        // AppendRunEvents is always rejected ("run is terminal"), so emitting
        // here can only fail the workflow after the business run completed.
        log.info(`RunCompleted ${input.runId} after ${turns} turns`);
        return text;
      }

      if (
        modelRes.finishReason === 'tool-call' &&
        modelRes.toolCalls &&
        modelRes.toolCalls.length > 0
      ) {
        // FL-1.1 (lockstep with the inline executor): EVERY proposed call is
        // processed — READ_ONLY calls run concurrently, MUTATING/DESTRUCTIVE
        // serialize in proposal order, and ONE bounded tool message joins the
        // turn so the next model call sees every outcome.
        interface ToolOutcomeEntry {
          toolCallId: string;
          toolName: string;
          success: boolean;
          result: unknown;
          denied?: boolean;
        }
        const entries = new Map<string, ToolOutcomeEntry>();
        // Call-ID → Engine approval ID for APPROVED mutating calls. The
        // approval loop below waits for the decision; on APPROVED the call
        // stays runnable and the ID must ride into executeTool, otherwise the
        // gateway rejects it with APPROVAL_REQUIRED after the user approved.
        const approvedCallIds = new ApprovalIdMap();
        const notAllowlisted: string[] = [];
        for (const call of modelRes.toolCalls) {
          if (toolByName.has(call.name)) continue;
          // Model proposed a tool outside the pinned definition — never execute it.
          // Untrusted model output cannot change the tool allowlist (1194-1205).
          notAllowlisted.push(call.name);
          entries.set(call.id, {
            toolCallId: call.id,
            toolName: call.name,
            success: false,
            result: { error: 'TOOL_NOT_ALLOWLISTED' },
          });
        }
        if (notAllowlisted.length > 0) {
          await emitEvent(
            {
              scope: {
                organizationId: input.organizationId,
                conversationId: input.conversationId,
                runId: input.runId,
                correlationId: input.correlationId,
              },
              type: 'RunWarning',
              body: {
                kind: 'RunWarning',
                runId: input.runId,
                code: 'TOOL_NOT_ALLOWLISTED',
                messageHash: `not in pinned set: ${notAllowlisted.join(',')}`,
              },
            },
            recoveryMaterial(),
          );
        }

        // Approval subset — one durable decision per call (approval id binds
        // run + turn + tool_call_id; Engine dedups the replay). Effect
        // classification comes from the pinned descriptor — never from model
        // output (Phase 6 policy boundary). DENIED calls become denial entries
        // the model sees; the run continues rather than fails.
        const approvalCalls = modelRes.toolCalls.filter((c) => {
          if (entries.has(c.id)) return false;
          // Agent-level policy: if the agent's pinned policy marks this tool as
          // 'required', it needs approval. This is the system of record for the
          // builder's "Always" setting (Engine 6ce51c1 / Product 215f7fd).
          const policy = input.agentApprovalPolicy?.[c.name];
          if (policy === 'required') return true;
          // Static descriptor is the fallback: tools with an inherent REQUIRED
          // approval requirement still need approval even if the agent policy
          // doesn't list them. Both sources are ORed — either can trigger.
          return toolByName.get(c.name)?.approvalRequirement === 'REQUIRED';
        });
        for (const call of approvalCalls) {
          const toolStepId = `${input.runId}#${input.workflowGeneration}#tool/${call.name}/${turns}`;
          const approvalId = `aprv_${input.runId}_${turns}_${call.id}`.slice(0, 64);
          progress.kernelState.status = 'REQUEST_APPROVAL';
          await createApprovalRequest(
            {
              approvalId,
              runId: input.runId,
              organizationId: input.organizationId,
              toolCallId: call.id,
              stepId: toolStepId,
              toolName: call.name,
            },
            recoveryMaterial(),
          );
          bumpHistory(2, 256);
          await emitEvent(
            {
              scope: {
                organizationId: input.organizationId,
                conversationId: input.conversationId,
                runId: input.runId,
                correlationId: input.correlationId,
              },
              type: 'ApprovalRequested',
              // toolStepId is the stable identity of this approval request:
              // without it, multiple approval-required calls in one turn
              // derive the same eventId and the Engine dedups all but the
              // first (same root cause as the ToolCallCompleted drop).
              stepId: toolStepId,
              body: {
                kind: 'ApprovalRequested',
                runId: input.runId,
                approvalId,
                toolCallId: call.id,
              },
            },
            recoveryMaterial(),
          );
          const decision = await waitForApprovalDecision(approvalId);
          if (!decision) {
            const cr2 = cancelRequested as { reason: string } | undefined;
            if (cr2 !== undefined) throw new Error(`CANCELLED:${cr2.reason}`);
            throw new Error(`APPROVAL_TIMEOUT:${approvalId}`);
          }
          // The Engine's approval decision bumps runs.version (WAITING_APPROVAL
          // → RUNNING). Refresh the CAS token now — every later version-guarded
          // activity (commitRunResult) must present the post-bump version, or
          // the terminal commit fails with "stale run version".
          try {
            const refreshed = await getRunVersion(recoveryMaterial());
            const v = extractVersionNumber(refreshed, 'version', 'runVersion');
            if (v > 0) expectedRunVersion = v;
          } catch {
            // Transient refresh failure — keep the admission version; the
            // terminal commit will surface a genuine staleness loudly.
          }
          if (decision.decision !== 'APPROVED') {
            await emitEvent(
              {
                scope: {
                  organizationId: input.organizationId,
                  conversationId: input.conversationId,
                  runId: input.runId,
                  correlationId: input.correlationId,
                },
                type: 'ApprovalReceived',
                stepId: toolStepId,
                body: {
                  kind: 'ApprovalReceived',
                  runId: input.runId,
                  approvalId,
                  decision: decision.decision ?? 'DENIED',
                },
              },
              recoveryMaterial(),
            );
            entries.set(call.id, {
              toolCallId: call.id,
              toolName: call.name,
              success: false,
              result: { error: 'APPROVAL_DENIED' },
              denied: true,
            });
          } else {
            // APPROVED: the call stays runnable, but executeTool still needs
            // the Engine approval ID or the gateway rejects it with
            // APPROVAL_REQUIRED — the approval would be silently lost.
            approvedCallIds.recordApproved(call.id, approvalId);
          }
        }

        const runnable = modelRes.toolCalls.filter((c) => !entries.has(c.id));
        // Tool budget per call (FL-1.2) — calls past the pinned cap fail
        // without executing; the run then fails BUDGET_EXHAUSTED below.
        const remainingToolBudget = Math.max(
          0,
          budgets.maxToolCalls - progress.kernelState.loopCounters.toolCalls,
        );
        const withinBudget = runnable.slice(0, remainingToolBudget);
        const overBudget = runnable.slice(remainingToolBudget);
        for (const call of overBudget) {
          entries.set(call.id, {
            toolCallId: call.id,
            toolName: call.name,
            success: false,
            result: { error: 'BUDGET_EXHAUSTED:maxToolCalls' },
          });
        }

        const pairs = withinBudget.flatMap((call) => {
          const descriptor = toolByName.get(call.name);
          return descriptor ? [{ call, descriptor }] : [];
        });
        const readOnly = pairs.filter((p) => p.descriptor.effectClass === 'READ_ONLY');
        const mutating = pairs.filter((p) => p.descriptor.effectClass !== 'READ_ONLY');

        const executeOne = async (
          call: { id: string; name: string; args?: unknown },
          descriptor: { version: string; effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE' },
          stepId: string,
          approvalId?: string,
        ): Promise<void> => {
          // A3-21 — the producer tells the truth up front: emit the toolCall
          // frame (name + sanitized args + model-assigned call id) BEFORE
          // invocation so the chat's tool-call card renders name/args and the
          // in-progress state; the ToolCallCompleted below resolves it.
          // Identity = execution stepId (same as the completion), so a
          // retried invocation replays to the same eventId (idempotent) and
          // distinct invocations never collide.
          // Patched: old in-flight histories never recorded this marker, so
          // they replay down the old path (straight to executeTool) instead
          // of failing nondeterminism on the inserted activity.
          if (patched(PATCH_IDS.TOOL_CALL_PROPOSED_V1)) {
            await emitEvent(
              {
                ...buildToolCallEmit({
                  scope: {
                    organizationId: input.organizationId,
                    conversationId: input.conversationId,
                    runId: input.runId,
                    correlationId: input.correlationId,
                  },
                  stepId,
                  toolName: call.name,
                  toolCallId: call.id,
                  args: call.args ?? {},
                }),
                // A3-21 — the summary carries user ticket-query content:
                // mark PII so the Engine persists it under the PII class.
                redaction: 'PII' as const,
              },
              recoveryMaterial(),
            );
          }
          const toolRes = await executeTool(
            {
              runId: input.runId,
              organizationId: input.organizationId,
              stepId,
              toolName: call.name,
              toolVersion: descriptor.version,
              args: call.args ?? {},
              idempotencyKey: `${input.runId}:${stepId}:${descriptor.version}`,
              effectClass: descriptor.effectClass,
              ...(approvalId !== undefined ? { approvalId } : {}),
              // Agent-level approval policy from the Engine (builder configuration).
              // Ensures "Always" approval is honored even for READ_ONLY tools.
              ...(input.agentApprovalPolicy !== undefined
                ? { agentApprovalPolicy: input.agentApprovalPolicy }
                : {}),
            },
            recoveryMaterial(),
          );
          bumpHistory(2, JSON.stringify(toolRes).length);
          progress.kernelState.loopCounters.toolCalls += 1;
          entries.set(call.id, {
            toolCallId: call.id,
            toolName: call.name,
            success: toolRes.success,
            result: toolRes.result ?? null,
          });
          // The event's identity IS the execution stepId: without it every
          // ToolCallCompleted in the run derives the same eventId and the
          // Engine dedups all but the first (see tool-call-events.ts).
          await emitEvent(
            buildToolCallCompletedEmit({
              scope: {
                organizationId: input.organizationId,
                conversationId: input.conversationId,
                runId: input.runId,
                correlationId: input.correlationId,
              },
              stepId,
              toolName: call.name,
              toolCallId: call.id,
              success: toolRes.success,
            }),
            recoveryMaterial(),
          );
          if (!toolRes.success && toolRes.outcome === 'UNKNOWN_OUTCOME') {
            await emitEvent(
              {
                scope: {
                  organizationId: input.organizationId,
                  conversationId: input.conversationId,
                  runId: input.runId,
                  correlationId: input.correlationId,
                },
                type: 'RunWarning',
                body: {
                  kind: 'RunWarning',
                  runId: input.runId,
                  code: 'UNKNOWN_OUTCOME',
                  messageHash: `tool ${call.name} reconciliation required`,
                },
              },
              recoveryMaterial(),
            );
            // Do not blindly retry — surface to caller
            throw new Error(`UNKNOWN_OUTCOME:${call.name}`);
          }
        };

        progress.kernelState.status = 'EXECUTE_TOOL';
        // Wave 1 — READ_ONLY concurrent (independent, no shared effects).
        await Promise.all(
          readOnly.map((p, i) =>
            executeOne(
              p.call,
              p.descriptor,
              `${input.runId}#${input.workflowGeneration}#tool/${p.call.name}/${turns}/r${i}`,
              approvedCallIds.forExecution(p.call.id),
            ),
          ),
        );
        // Wave 2 — MUTATING/DESTRUCTIVE serialized in proposal order.
        for (const [i, p] of mutating.entries()) {
          await executeOne(
            p.call,
            p.descriptor,
            `${input.runId}#${input.workflowGeneration}#tool/${p.call.name}/${turns}/m${i}`,
            approvedCallIds.forExecution(p.call.id),
          );
        }
        if (overBudget.length > 0) {
          throw new Error('BUDGET_EXHAUSTED:maxToolCalls');
        }

        // ONE bounded tool message per turn — every outcome the model proposed.
        const ordered = modelRes.toolCalls
          .map((c) => entries.get(c.id))
          .filter((e): e is ToolOutcomeEntry => e !== undefined)
          .map((e): WorkflowToolOutcome => ({
            tool_call_id: e.toolCallId,
            tool: e.toolName,
            status: e.success ? 'EXECUTED' : e.denied ? 'DENIED' : 'FAILED',
            result: e.result,
          }));
        // ONE tool message per turn — CoreMessage tool-result parts
        // (see buildToolResultHistoryMessage).
        messages.push(buildToolResultHistoryMessage(ordered));
        // FL-2.16 - trim consumed tool messages past the bound (cache-safe:
        // the stable prefix is untouched; only post-prefix tool rows drop).
        // Size counts serialized content: string content directly, part
        // arrays via their JSON form (tool-result parts carry real payload).
        {
          const contentChars = (c: ModelMessageContent): number => {
            if (typeof c === 'string') return c.length;
            try {
              return JSON.stringify(c).length;
            } catch {
              return 0;
            }
          };
          const totalChars = messages.reduce((acc, m) => acc + contentChars(m.content), 0);
          if (totalChars > 24_000) {
            const toolPositions = messages
              .map((m, i) => (m.role === 'tool' ? i : -1))
              .filter((i) => i >= 0);
            if (toolPositions.length > 2) {
              const keep = new Set(toolPositions.slice(-2));
              for (let i = messages.length - 1; i >= 0; i--) {
                const pos = toolPositions.includes(i);
                if (pos && !keep.has(i)) messages.splice(i, 1);
              }
            }
          }
        }
        // FL-2.17 - durable loop-state checkpoint after every tool turn.
        await saveCheckpoint(
          {
            runId: input.runId,
            organizationId: input.organizationId,
            state: {
              messages,
              turn: turns,
              totalPrompt: usedTokens.prompt,
              totalCompletion: usedTokens.completion,
              toolCallsExecuted: progress.kernelState.loopCounters.toolCalls,
            },
          },
          recoveryMaterial(),
        );
        progress.kernelState.status = 'MODEL_STEP';
        continue;
      }

      // Handoff / unknown finish → finalize
      progress.kernelState.status = 'FINALIZE';
      await commitRunResult(
        {
          resultText: modelRes.text ?? '',
          expectedVersion: expectedRunVersion,
        },
        recoveryMaterial(),
      );
      progress.kernelState.status = 'COMMIT_RESULT';
      return modelRes.text ?? '';
    }

    // Budget turns exhausted → fail closed
    throw new Error('BUDGET_EXHAUSTED:maxTurns');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('CANCELLED:')) {
      // Cancel is durable — propagate to provider/tool via CancellationScope, then failRun idempotent
      const reason = msg.slice('CANCELLED:'.length);
      try {
        await failRun({ errorCode: 'CANCELLED', errorMessage: reason }, recoveryMaterial());
      } catch {
        // best-effort — workflow will be cancelled anyway
      }
      progress.kernelState.status = 'CANCELLED';
      progress.kernelState.cancelled = true;
      // No RunFailed emit: failRun above writes the terminal `run.failed`
      // run-event atomically with the FAILED transition (Engine owns the run
      // lifecycle); a post-terminal AppendRunEvents is always rejected.
      throw err;
    }
    if (msg.startsWith('CONTINUE_AS_NEW:')) {
      // Real continueAsNew — pass next generation with same runId, bump generation for stepId stability
      const nextInput: AgentRunWorkflowInput = {
        ...input,
        workflowGeneration: input.workflowGeneration + 1,
      };
      await continueAsNew<typeof agentRunWorkflow>(nextInput);
      // Unreachable — workflow restarts
      throw err;
    }
    // Any other deterministic failure → FAIL + failRun (idempotent, never duplicate).
    // Budget breaches carry their dimension (FL-1.2 lockstep with the inline
    // executor's RunWarning + FailRun(BUDGET_EXHAUSTED)).
    if (msg.startsWith('BUDGET_EXHAUSTED:')) {
      await emitEvent(
        {
          scope: {
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            runId: input.runId,
            correlationId: input.correlationId,
          },
          type: 'RunWarning',
          body: {
            kind: 'RunWarning',
            runId: input.runId,
            code: 'BUDGET_EXHAUSTED',
            messageHash: `budget dimension exhausted: ${msg.slice('BUDGET_EXHAUSTED:'.length)}`,
          },
        },
        recoveryMaterial(),
      ).catch(() => {});
    }
    try {
      // A2-68 — unwrap the Temporal failure chain so the terminal event/row
      // names the real cause (e.g. tool policy denied: create_ticket) instead
      // of the generic code=FAILED / "Activity task failed".
      const terminal = classifyTerminalFailure(err);
      const budgetBreach = msg.startsWith('BUDGET_EXHAUSTED:');
      await failRun(
        {
          errorCode: budgetBreach ? 'BUDGET_EXHAUSTED' : terminal.code,
          errorMessage: (budgetBreach ? msg : terminal.message).slice(0, 1024),
        },
        recoveryMaterial(),
      );
    } catch (reconcileErr) {
      // failRun itself is idempotent — ignore duplicate-terminal noise. But a
      // failed run-client recovery is a loud reconciliation failure: the
      // Engine row may still be non-terminal while Temporal marks the
      // workflow FAILED. Surface it (never swallow) so it pages instead of
      // diverging silently like the Wave 4 worker-kill run did.
      const reconcileMsg =
        reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr);
      if (reconcileMsg.startsWith(RECOVERY_FAILED_PREFIX)) {
        throw new Error(`${reconcileMsg}:original=${msg.slice(0, 200)}`);
      }
    }
    progress.kernelState.status = 'FAILED';
    // No RunFailed emit: failRun above writes the terminal `run.failed`
    // run-event atomically with the FAILED transition (Engine owns the run
    // lifecycle); a post-terminal AppendRunEvents is always rejected, and if
    // failRun itself failed the emit would fail the same lease/version check.
    throw err;
  } finally {
    // Epoch-fenced lease release — best effort; safe on CAN (next generation re-claims)
    try {
      if (leaseEpoch > 0) {
        await _releaseRunLease(leaseEpoch, recoveryMaterial());
      }
    } catch {
      // ignore — Engine lease expiry is the safety net
    }
  }
}
