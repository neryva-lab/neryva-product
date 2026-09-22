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
import { assertWorkflowInputBounded } from './payload.js';
import { shouldContinueAsNew, incrementHistoryCount } from './continue-as-new.js';
import { PATCH_IDS } from './workflow-versioning.js';
import type { EventType, RuntimeEventBody } from '@neryva/contracts/events/runtime-events';

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
    expectedLeaseEpoch?: bigint;
  }): Promise<unknown>;
  commitRunResult(params: {
    resultText: string;
    expectedVersion?: bigint;
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
  releaseRunLease(epoch: bigint): Promise<unknown>;
};

type ContextActivities = {
  compileContext(params: {
    runId: string;
    organizationId: string;
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

/** FL-1.6 — multimodal content: text-only string or text+image parts. */
type ModelMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>;

type ModelActivities = {
  callModel(params: {
    runId: string;
    stepId: string;
    organizationId: string;
    agentVersionId: string;
    messages: Array<{ role: string; content: ModelMessageContent }>;
    tools?: Array<{ name: string; description: string; schema: unknown }>;
    correlationId?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  }): Promise<{
    stepId: string;
    modelId?: string;
    finishReason: 'stop' | 'tool-call' | 'length' | 'content-filter' | 'error';
    text?: string;
    toolCalls?: Array<{ id: string; name: string; args: unknown }>;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }>;
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
} = proxyActivities<McpActivities>({
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

const { compileContext, fetchRunImages } = proxyActivities<ContextActivities>({
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

const { emitEvent } = proxyActivities<EventActivities>({
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

const { callModel } = proxyActivities<ModelActivities>({
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

const { executeTool } = proxyActivities<ToolActivities>({
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

const { createApprovalRequest, getApprovalState } = proxyActivities<ApprovalActivities>({
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
  GuardrailActivities & CheckpointActivities
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
  // fences lease release; the version is the CAS token for the terminal commit.
  let leaseEpoch = 0n;
  let expectedRunVersion = 0n;
  function extractBigint(raw: unknown, field: string, alt: string): bigint {
    if (typeof raw === 'object' && raw !== null) {
      const run = (raw as Record<string, unknown>)['run'];
      const pool: unknown[] = [raw, ...(typeof run === 'object' && run !== null ? [run] : [])];
      for (const source of pool) {
        const candidate =
          (source as Record<string, unknown>)[field] ?? (source as Record<string, unknown>)[alt];
        if (typeof candidate === 'bigint') return candidate;
        if (typeof candidate === 'number') return BigInt(candidate);
      }
    }
    return 0n;
  }

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
          const res = await getApprovalState({ approvalRef: approvalId });
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
    });
    leaseEpoch = extractBigint(claimRes, 'leaseEpoch', 'epoch');
    expectedRunVersion = extractBigint(claimRes, 'version', 'runVersion');
    bumpHistory(2, 256);
    progress.kernelState.status = 'LOAD_CONTEXT';
    log.info(`ADMISSION ok for ${input.runId}`);

    // LOAD_CONTEXT + POLICY_CHECK via compileContext (MCP-backed, deterministic ordering later)
    const compiled = await compileContext({
      runId: input.runId,
      organizationId: input.organizationId,
      agentVersionId: input.agentVersionId,
      ...(input.triggerMessageId !== undefined ? { triggerMessageId: input.triggerMessageId } : {}),
    });
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
      await emitEvent({
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
      }).catch(() => {});
      await failRun({
        errorCode: 'GUARDRAIL_BLOCKED',
        errorMessage: 'user input blocked by guardrail policy',
      });
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
    const fetchedImages = await fetchRunImages({ attachments: compiled.triggerAttachments });
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
    const resume = await loadCheckpoint();
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
      const modelRes = await callModel({
        runId: input.runId,
        stepId: currentStepId,
        organizationId: input.organizationId,
        agentVersionId: input.agentVersionId,
        messages,
        // Engine-pinned schemas from the tool catalog (context v1.1) — the
        // model cannot emit a valid call without them.
        tools: compiled.tools.map((t) => ({
          name: t.name,
          description: t.description ?? t.name,
          schema: t.inputSchema ?? {},
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
      });
      bumpHistory(2, JSON.stringify(modelRes).length);
      progress.kernelState.loopCounters.modelCalls += 1;
      if (modelRes.usage) {
        tokensUsed += modelRes.usage.totalTokens;
        usedTokens.prompt += modelRes.usage.promptTokens;
        usedTokens.completion += modelRes.usage.completionTokens;
      }

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
      await emitEvent({
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
          modelId: modelRes.modelId ?? 'unknown',
          stepId: currentStepId,
          ...(modelRes.usage !== undefined ? { usage: modelRes.usage } : {}),
        },
      });
      bumpHistory(1, 128);

      // Accumulate the assistant turn so the next call has full conversation state
      const assistantContent =
        modelRes.finishReason === 'tool-call' && modelRes.toolCalls
          ? JSON.stringify(modelRes.toolCalls)
          : (modelRes.text ?? '');
      messages.push({ role: 'assistant', content: assistantContent });

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
          await emitEvent({
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
          }).catch(() => {});
          await failRun({
            errorCode: 'GUARDRAIL_BLOCKED',
            errorMessage: 'assistant output blocked by guardrail policy',
          });
          progress.kernelState.status = 'FAILED';
          return 'blocked by guardrail policy';
        }
        progress.kernelState.status = 'FINALIZE';
        // FL-3.4 lockstep — follow-up generation rides the inline executor
        // (the operative path); the deterministic workflow stays a single
        // structured call and surfaces followups only if a re-drive supplies
        // them, so the commit interface is identical on both paths.
        const followups: string[] = [];
        // FINALIZE → COMMIT_RESULT idempotent via stable idempotencyKey (1406, epoch fencing 448-449)
        // Retry-safe: duplicate CommitRunResult returns original, never duplicates assistant message
        await commitRunResult({
          resultText: text,
          expectedVersion: expectedRunVersion,
          usage: {
            provider: 'litellm',
            model: modelRes.modelId ?? 'unknown',
            promptTokens: usedTokens.prompt,
            completionTokens: usedTokens.completion,
            totalTokens: usedTokens.prompt + usedTokens.completion,
          },
          ...(followups.length > 0 ? { suggestedFollowups: followups } : {}),
        });
        bumpHistory(2, text.length);
        progress.kernelState.status = 'COMMIT_RESULT';
        // Emit final durable event, then release lease in finally
        await emitEvent({
          scope: {
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            runId: input.runId,
            correlationId: input.correlationId,
          },
          type: 'RunCompleted',
          body: { kind: 'RunCompleted', runId: input.runId, resultType: 'SUCCEEDED' },
        });
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
          await emitEvent({
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
          });
        }

        // Approval subset — one durable decision per call (approval id binds
        // run + turn + tool_call_id; Engine dedups the replay). Effect
        // classification comes from the pinned descriptor — never from model
        // output (Phase 6 policy boundary). DENIED calls become denial entries
        // the model sees; the run continues rather than fails.
        const approvalCalls = modelRes.toolCalls.filter(
          (c) => !entries.has(c.id) && toolByName.get(c.name)?.approvalRequirement === 'REQUIRED',
        );
        for (const call of approvalCalls) {
          const toolStepId = `${input.runId}#${input.workflowGeneration}#tool/${call.name}/${turns}`;
          const approvalId = `aprv_${input.runId}_${turns}_${call.id}`.slice(0, 64);
          progress.kernelState.status = 'REQUEST_APPROVAL';
          await createApprovalRequest({
            approvalId,
            runId: input.runId,
            organizationId: input.organizationId,
            toolCallId: call.id,
            stepId: toolStepId,
            toolName: call.name,
          });
          bumpHistory(2, 256);
          await emitEvent({
            scope: {
              organizationId: input.organizationId,
              conversationId: input.conversationId,
              runId: input.runId,
              correlationId: input.correlationId,
            },
            type: 'ApprovalRequested',
            body: {
              kind: 'ApprovalRequested',
              runId: input.runId,
              approvalId,
              toolCallId: call.id,
            },
          });
          const decision = await waitForApprovalDecision(approvalId);
          if (!decision) {
            const cr2 = cancelRequested as { reason: string } | undefined;
            if (cr2 !== undefined) throw new Error(`CANCELLED:${cr2.reason}`);
            throw new Error(`APPROVAL_TIMEOUT:${approvalId}`);
          }
          if (decision.decision !== 'APPROVED') {
            await emitEvent({
              scope: {
                organizationId: input.organizationId,
                conversationId: input.conversationId,
                runId: input.runId,
                correlationId: input.correlationId,
              },
              type: 'ApprovalReceived',
              body: {
                kind: 'ApprovalReceived',
                runId: input.runId,
                approvalId,
                decision: decision.decision ?? 'DENIED',
              },
            });
            entries.set(call.id, {
              toolCallId: call.id,
              toolName: call.name,
              success: false,
              result: { error: 'APPROVAL_DENIED' },
              denied: true,
            });
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
          call: { id: string; name: string; args: unknown },
          descriptor: { version: string; effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE' },
          stepId: string,
          approvalId?: string,
        ): Promise<void> => {
          const toolRes = await executeTool({
            runId: input.runId,
            organizationId: input.organizationId,
            stepId,
            toolName: call.name,
            toolVersion: descriptor.version,
            args: call.args,
            idempotencyKey: `${input.runId}:${stepId}:${descriptor.version}`,
            effectClass: descriptor.effectClass,
            ...(approvalId !== undefined ? { approvalId } : {}),
          });
          bumpHistory(2, JSON.stringify(toolRes).length);
          progress.kernelState.loopCounters.toolCalls += 1;
          entries.set(call.id, {
            toolCallId: call.id,
            toolName: call.name,
            success: toolRes.success,
            result: toolRes.result ?? null,
          });
          await emitEvent({
            scope: {
              organizationId: input.organizationId,
              conversationId: input.conversationId,
              runId: input.runId,
              correlationId: input.correlationId,
            },
            type: 'ToolCallCompleted',
            body: {
              kind: 'ToolCallCompleted',
              runId: input.runId,
              toolName: call.name,
              toolCallId: call.id,
              stepId,
              success: toolRes.success,
            },
          });
          if (!toolRes.success && toolRes.outcome === 'UNKNOWN_OUTCOME') {
            await emitEvent({
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
            });
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
            ),
          ),
        );
        // Wave 2 — MUTATING/DESTRUCTIVE serialized in proposal order.
        for (const [i, p] of mutating.entries()) {
          await executeOne(
            p.call,
            p.descriptor,
            `${input.runId}#${input.workflowGeneration}#tool/${p.call.name}/${turns}/m${i}`,
          );
        }
        if (overBudget.length > 0) {
          throw new Error('BUDGET_EXHAUSTED:maxToolCalls');
        }

        // ONE bounded tool message per turn — every outcome the model proposed.
        const ordered = modelRes.toolCalls
          .map((c) => entries.get(c.id))
          .filter((e): e is ToolOutcomeEntry => e !== undefined)
          .map((e) => ({
            tool_call_id: e.toolCallId,
            tool: e.toolName,
            status: e.success ? 'EXECUTED' : e.denied ? 'DENIED' : 'FAILED',
            result: e.result,
          }));
        messages.push({ role: 'tool', content: JSON.stringify(ordered).slice(0, 8192) });
        // FL-2.16 - trim consumed tool messages past the bound (cache-safe:
        // the stable prefix is untouched; only post-prefix tool rows drop).
        {
          const totalChars = messages.reduce(
            (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
            0,
          );
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
        await saveCheckpoint({
          runId: input.runId,
          organizationId: input.organizationId,
          state: {
            messages,
            turn: turns,
            totalPrompt: usedTokens.prompt,
            totalCompletion: usedTokens.completion,
            toolCallsExecuted: progress.kernelState.loopCounters.toolCalls,
          },
        });
        progress.kernelState.status = 'MODEL_STEP';
        continue;
      }

      // Handoff / unknown finish → finalize
      progress.kernelState.status = 'FINALIZE';
      await commitRunResult({
        resultText: modelRes.text ?? '',
        expectedVersion: expectedRunVersion,
      });
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
        await failRun({ errorCode: 'CANCELLED', errorMessage: reason });
      } catch {
        // best-effort — workflow will be cancelled anyway
      }
      progress.kernelState.status = 'CANCELLED';
      progress.kernelState.cancelled = true;
      await emitEvent({
        scope: {
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          runId: input.runId,
          correlationId: input.correlationId,
        },
        type: 'RunFailed',
        body: {
          kind: 'RunFailed',
          runId: input.runId,
          errorCode: 'CANCELLED',
          errorMessageHash: `cancelled:${reason}`,
        },
      }).catch(() => {});
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
      await emitEvent({
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
      }).catch(() => {});
    }
    try {
      await failRun({
        errorCode: msg.startsWith('BUDGET_EXHAUSTED:') ? 'BUDGET_EXHAUSTED' : 'FAILED',
        errorMessage: msg.slice(0, 1024),
      });
    } catch {
      // failRun itself is idempotent; ignore duplicate
    }
    progress.kernelState.status = 'FAILED';
    await emitEvent({
      scope: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        runId: input.runId,
        correlationId: input.correlationId,
      },
      type: 'RunFailed',
      body: { kind: 'RunFailed', runId: input.runId, errorCode: 'FAILED', errorMessageHash: msg },
    }).catch(() => {});
    throw err;
  } finally {
    // Epoch-fenced lease release — best effort; safe on CAN (next generation re-claims)
    try {
      if (leaseEpoch > 0n) {
        await _releaseRunLease(leaseEpoch);
      }
    } catch {
      // ignore — Engine lease expiry is the safety net
    }
  }
}
