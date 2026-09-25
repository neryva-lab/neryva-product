/**
 * internal-control.ts — audited operator controls, stateless, no public customer API
 * Source: neryva_mcp_implementation_plan.md:348-366, agent_studio_implementation_plan.md:1102-1117, 521-525
 * Any operational command maps to audited MCP/Temporal op (523-525).
 * StartRun deterministic Workflow ID from run_id → no duplicate workflow (1106)
 * CancelRun; DeliverRunInput → Signal by default, Update only when sync validation/tracking needed; drain at safe points.
 */

import { z } from 'zod';

export const StartRunSchema = z.object({
  runId: z.string().uuid(),
  organizationId: z.string().uuid(),
  conversationId: z.string().uuid(),
  agentVersionId: z.string().min(1),
  policySnapshotId: z.string().min(1),
  triggerMessageId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1),
  correlationId: z.string().min(1),
  // Engine-issued run-scoped capability — forwarded to the executor, which
  // presents it on every authority RPC. Studio never validates it (Engine
  // re-validates on each call); it only refuses to start without one.
  capabilityToken: z.string().min(1),
  capabilityId: z.string().min(1).default('engine-dispatch'),
  actorId: z.string().min(1).default('engine-dispatcher'),
  // Agent-level per-tool approval policy (from assistant_versions.tool_policy).
  // Maps tool name -> 'required' | 'optional' | 'none'. The workflow passes this
  // to the gateway to enforce the builder's "Always" setting at execution time.
  agentApprovalPolicy: z.record(z.string(), z.enum(['required', 'optional', 'none'])).optional(),
});

export type StartRunInput = z.infer<typeof StartRunSchema>;

export const CancelRunSchema = z.object({
  runId: z.string().uuid(),
  reason: z.string().min(1),
  requestedBy: z.string().min(1),
});

export type CancelRunInput = z.infer<typeof CancelRunSchema>;

export const DeliverInputSchema = z.object({
  runId: z.string().uuid(),
  requestId: z.string().min(1),
  inputType: z.enum(['USER_MESSAGE', 'TOOL_RESULT', 'APPROVAL_DECISION']),
  payload: z.unknown(),
  idempotencyKey: z.string().min(1),
  // If true, use Temporal Update (sync validation); else Signal (default)
  requireSyncValidation: z.boolean().optional().default(false),
});

export type DeliverInput = z.infer<typeof DeliverInputSchema>;

export function deriveWorkflowId(runId: string): string {
  return `agent-run::${runId}`;
}

/**
 * RuntimeControlService — stateless facade over Temporal Client + Neryva MCP.
 * Each method is audited (caller + organization_id + run_id + timestamp) and maps to exactly one MCP/Temporal op.
 */
export interface TemporalClientLike {
  startWorkflow(
    workflowType: string,
    input: unknown,
    options: { workflowId: string; taskQueue: string; idempotencyKey?: string },
  ): Promise<{ workflowId: string; runId: string }>;
  signalWorkflow(workflowId: string, signalName: string, payload: unknown): Promise<void>;
  updateWorkflow(workflowId: string, updateName: string, payload: unknown): Promise<unknown>;
  queryWorkflow(workflowId: string, queryName: string): Promise<unknown>;
  cancelWorkflow(workflowId: string): Promise<void>;
}

export interface McpClientLike {
  createRun?(params: StartRunInput): Promise<unknown>;
  cancelRun?(params: CancelRunInput): Promise<unknown>;
}

export interface InlineRunExecutor {
  (input: {
    runId: string;
    organizationId: string;
    conversationId: string;
    agentVersionId: string;
    actorId: string;
    capabilityId: string;
    capabilityToken: string;
  }): Promise<{ resultText: string }>;
}

/**
 * Inline cancellation port (FL-1.3) — aborts the run-scoped AbortController
 * of an in-flight inline execution. Returns false when the run is not
 * executing in this process (finished, temporal mode, or owned elsewhere).
 */
export type InlineRunCanceller = (runId: string, reason: string) => boolean;

export class RuntimeControlService {
  constructor(
    private readonly temporal: TemporalClientLike,
    private readonly mcp: McpClientLike,
    private readonly taskQueue: string,
    private readonly audit: (event: string, detail: unknown) => void = () => {},
    private readonly inlineExecutor?: InlineRunExecutor | undefined,
    private readonly inlineCancel?: InlineRunCanceller | undefined,
  ) {}

  /**
   * StartRun — deterministic WorkflowId from runId ensures no duplicate workflow for same run.
   * Engine is system of record: Studio must claim run via MCP or Engine creates run first; this path assumes run already exists.
   * Idempotent: same runId + same workflowId → Temporal returns existing workflow or throws WorkflowExecutionAlreadyStarted which we map to idempotent success.
   */
  async startRun(input: StartRunInput): Promise<{ workflowId: string; alreadyStarted: boolean }> {
    const parsed = StartRunSchema.parse(input);
    const workflowId = deriveWorkflowId(parsed.runId);
    this.audit('StartRun', {
      runId: parsed.runId,
      organizationId: parsed.organizationId,
      workflowId,
    });

    // Inline execution mode: run directly in this process. The deterministic
    // workflowId + Engine lease fencing keep concurrent starts safe; failures
    // surface via the Engine's accepted-run sweep (invariant 6).
    if (this.inlineExecutor) {
      const execInput = {
        runId: parsed.runId,
        organizationId: parsed.organizationId,
        conversationId: parsed.conversationId,
        agentVersionId: parsed.agentVersionId,
        actorId: parsed.actorId,
        capabilityId: parsed.capabilityId,
        capabilityToken: parsed.capabilityToken,
      };
      void this.inlineExecutor(execInput).catch((err: unknown) => {
        this.audit('InlineRunError', { runId: parsed.runId, error: (err as Error).message });
      });
      return { workflowId: `inline::${workflowId}`, alreadyStarted: false };
    }

    try {
      const res = await this.temporal.startWorkflow(
        'agentRunWorkflow',
        {
          runId: parsed.runId,
          organizationId: parsed.organizationId,
          conversationId: parsed.conversationId,
          agentVersionId: parsed.agentVersionId,
          policySnapshotId: parsed.policySnapshotId,
          triggerMessageId: parsed.triggerMessageId,
          idempotencyKey: parsed.idempotencyKey,
          correlationId: parsed.correlationId,
          workflowGeneration: 1,
          // Engine-issued run-scoped capability — the worker presents it as
          // Authorization: Bearer on every Engine MCP RPC. Dropped here it
          // never reaches the worker and every RPC fails permission_denied.
          capabilityToken: parsed.capabilityToken,
          capabilityId: parsed.capabilityId,
          // Agent-level per-tool approval policy from the Engine.
          // Ensures the builder's "Always" setting is honored at execution time.
          ...(parsed.agentApprovalPolicy !== undefined
            ? { agentApprovalPolicy: parsed.agentApprovalPolicy }
            : {}),
        } satisfies Record<string, unknown>,
        {
          workflowId,
          taskQueue: this.taskQueue,
          idempotencyKey: parsed.idempotencyKey,
        },
      );
      return { workflowId: res.workflowId, alreadyStarted: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('AlreadyStarted') || msg.includes('ALREADY_EXISTS')) {
        return { workflowId, alreadyStarted: true };
      }
      throw err;
    }
  }

  async cancelRun(input: CancelRunInput): Promise<void> {
    const parsed = CancelRunSchema.parse(input);
    const workflowId = deriveWorkflowId(parsed.runId);
    this.audit('CancelRun', parsed);

    // Inline mode: abort the in-flight provider call in THIS process. The
    // Engine has already persisted CANCELED before this RPC lands (Studio
    // never owns run state — the abort only stops local work, FL-1.3).
    if (this.inlineExecutor && this.inlineCancel?.(parsed.runId, parsed.reason)) {
      this.audit('InlineRunCancelled', { runId: parsed.runId, reason: parsed.reason });
      return;
    }

    // 1. Signal workflow — durable, survives restart, cancel propagates Engine→Studio→Temporal→provider/tool (1405)
    await this.temporal.signalWorkflow(workflowId, 'CancelRun', {
      reason: parsed.reason,
      requestedBy: parsed.requestedBy,
      requestedAt: new Date().toISOString(),
    });

    // 2. MCP cancel for Engine ledger — audited, best-effort
    try {
      await this.mcp.cancelRun?.(parsed);
    } catch {
      // Temporal signal is durable; MCP ledger update will be retried via outbox
    }
  }

  /**
   * DeliverRunInput — Signal by default (durable), Update only when sync validation needed.
   * Caller chooses; workflow drains at safe points (MODEL_STEP boundary, not mid-activity).
   */
  async deliverRunInput(
    input: DeliverInput,
  ): Promise<{ delivered: boolean; via: 'signal' | 'update'; result?: unknown }> {
    const parsed = DeliverInputSchema.parse(input);
    const workflowId = deriveWorkflowId(parsed.runId);
    this.audit('DeliverRunInput', {
      runId: parsed.runId,
      inputType: parsed.inputType,
      via: parsed.requireSyncValidation ? 'update' : 'signal',
    });

    if (parsed.requireSyncValidation) {
      const result = await this.temporal.updateWorkflow(workflowId, 'DeliverRunInputUpdate', {
        requestId: parsed.requestId,
        inputType: parsed.inputType,
        payload: parsed.payload,
        idempotencyKey: parsed.idempotencyKey,
      });
      return { delivered: true, via: 'update', result };
    } else {
      await this.temporal.signalWorkflow(workflowId, 'DeliverRunInput', {
        requestId: parsed.requestId,
        inputType: parsed.inputType,
        payload: parsed.payload,
        idempotencyKey: parsed.idempotencyKey,
      });
      return { delivered: true, via: 'signal' };
    }
  }

  async getProgress(runId: string): Promise<unknown> {
    const workflowId = deriveWorkflowId(runId);
    return this.temporal.queryWorkflow(workflowId, 'getProgress');
  }
}
