/**
 * AgentRunWorkflow — deterministic workflow, no side-effects in workflow code.
 * Reference: neryva_mcp_implementation_plan.md:658-670, 632-663
 *
 * 8 rules enforced:
 * 1. Workflow code is deterministic (no direct random/date — use ctx.now/ctx.random)
 * 2. Network/DB/fs/clock/random/tool in Activities only (via ctx.activity)
 * 3. Inputs contain IDs/versions/refs only (bounded), not full docs/secrets `640`
 * 4. Explicit timeouts for Activities (startToClose, scheduleToClose)
 * 5. Long Activities heartbeat with resumable details `1099`
 * 6. Explicit retry policies; non-retryable marked ` FAILED_PRECONDITION`
 * 7. Continue-As-New on measured history growth `644`, not magic constants
 * 8. Cancellation propagates Engine→Studio→Temporal→provider `645`
 *
 * Workflow owns: execution progress, step counter, pending signals queue.
 * Engine owns: business run state, terminal, canonical messages `652-663`.
 */

export interface WorkflowInput {
  runId: string;
  organizationId: string;
  conversationId: string;
  assistantVersionId: string;
  inputMessageId: string;
  expectedConversationVersion: string; // bigint string
  capabilityToken: string;
}

export interface WorkflowResult {
  runId: string;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  messageId?: string;
  failureCode?: string;
}

export interface WorkflowContext {
  // Deterministic time — use ctx.now() for replay-safe clock
  now(): number; // ms since workflow start (deterministic replay)
  // Deterministic random via workflow seed (use ctx.random)
  random(): number;
  // Activity invocation — only way to do I/O
  activity<T>(name: string, input: unknown, opts?: { startToCloseTimeoutMs?: number; heartbeatTimeoutMs?: number; retryPolicy?: { maxAttempts: number; nonRetryable?: string[] } }): Promise<T>;
  // Signal handling — drain pending signals at safe points `630`
  consumeSignals(kind?: string): unknown[];
  // Checkpoint — record progress for resume by replacement worker `116`
  saveCheckpoint(checkpointId: string, version: bigint, artifactRef: unknown): Promise<void>;
  // Heartbeat for long activities
  heartbeat(details: unknown): void;
  // Cancellation
  isCancelled(): boolean;
  throwIfCancelled(): void;
  // History tracking for Continue-As-New
  historySize(): number;
  shouldContinueAsNew(): boolean;
}

/**
 * Main workflow — deterministic, no side-effects.
 * All outside-world calls are via ctx.activity().
 */
export async function AgentRunWorkflow(input: WorkflowInput, ctx: WorkflowContext): Promise<WorkflowResult> {
  // Input validation: only IDs/refs, not large docs `640` — enforced by ctx.activity input size check
  if (!input.runId || !input.organizationId || !input.conversationId) {
    throw new Error("invalid workflow input: missing IDs");
  }

  // 1. Acquire lease via Activity (fenced, epoch-checked `448-449`)
  const lease = await ctx.activity<{ leaseEpoch: string; leaseOwner: string }>("acquireLease", {
    runId: input.runId,
    organizationId: input.organizationId,
  }, { startToCloseTimeoutMs: 5000, retryPolicy: { maxAttempts: 3, nonRetryable: ["FAILED_PRECONDITION", "ABORTED"] } });
  ctx.heartbeat({ leaseEpoch: lease.leaseEpoch });

  // 2. Get authorized context via Activity (tenant WHERE before serialization `566`)
  const manifest = await ctx.activity("getAuthorizedContext", {
    runId: input.runId,
    organizationId: input.organizationId,
  }, { startToCloseTimeoutMs: 3000 });

  // Check cancellation before model call `645`
  ctx.throwIfCancelled();

  // 3. Drain any pending approval/user-input signals that arrived before model loop `630`
  const pendingInputs = ctx.consumeSignals("DeliverRunInput");
  if (pendingInputs.length > 0) {
    // In real workflow, would incorporate inputs into context
    await ctx.activity("handleInputs", { inputs: pendingInputs }, { startToCloseTimeoutMs: 2000 });
  }

  // 4. Model loop (simplified for spike: one model call + one tool call)
  // Model call via Activity (outside workflow) `639`
  const modelRes = await ctx.activity<{ text: string; toolCalls?: Array<{ toolName: string; args: unknown }> }>("callModel", {
    runId: input.runId,
    manifest, // manifest is bounded, not full transcript `640`
  }, { startToCloseTimeoutMs: 15000, heartbeatTimeoutMs: 5000, retryPolicy: { maxAttempts: 2 } });

  ctx.throwIfCancelled();

  // 5. Tool loop if model proposed tools
  if (modelRes.toolCalls && modelRes.toolCalls.length > 0) {
    for (const tc of modelRes.toolCalls) {
      ctx.throwIfCancelled();
      // Authorize tool via Engine Activity (independent of model `125`)
      const auth = await ctx.activity<{ allowed: boolean }>("authorizeToolCall", {
        runId: input.runId,
        toolName: tc.toolName,
        args: tc.args,
      }, { startToCloseTimeoutMs: 2000, retryPolicy: { maxAttempts: 1, nonRetryable: ["PERMISSION_DENIED"] } });
      if (!auth.allowed) continue;
      // Execute tool via Activity (effectful, needs idempotency `609-616`)
      const outcome = await ctx.activity("executeTool", {
        runId: input.runId,
        toolName: tc.toolName,
        args: tc.args,
      }, { startToCloseTimeoutMs: 10000, heartbeatTimeoutMs: 3000 });
      // Record outcome via Engine Activity (dedup `RecordToolOutcome`)
      await ctx.activity("recordToolOutcome", {
        runId: input.runId,
        toolCallId: tc.toolName,
        outcome,
      }, { startToCloseTimeoutMs: 2000 });
      ctx.heartbeat({ tool: tc.toolName, step: "tool_done" });
      // Checkpoint after each tool for resume `1099` — use deterministic now
      await ctx.saveCheckpoint(`ckpt-${input.runId}-${ctx.now()}`, BigInt(ctx.historySize()), { purpose: "checkpoint" });
    }
  }

  // 6. Check for Continue-As-New (measured history growth `644`)
  if (ctx.shouldContinueAsNew()) {
    // In real Temporal, would call continueAsNew with same input + history trimmed
    // For spike, we simulate by returning a marker that worker will handle
    return { runId: input.runId, status: "FAILED", failureCode: "CONTINUE_AS_NEW" };
  }

  // 7. Commit result via Engine Activity (Engine-only terminal `98`)
  const commit = await ctx.activity<{ messageId: string }>("commitRunResult", {
    runId: input.runId,
    text: modelRes.text,
  }, { startToCloseTimeoutMs: 5000, retryPolicy: { maxAttempts: 1, nonRetryable: ["ABORTED", "FAILED_PRECONDITION"] } });

  return { runId: input.runId, status: "SUCCEEDED", messageId: commit.messageId };
}
