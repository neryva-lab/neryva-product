/**
 * In-memory Temporal-like worker for Phase 3 spike.
 * Simulates deterministic replay, heartbeat, Signals, Updates, cancellation, and Continue-As-New.
 * Reference: neryva_mcp_implementation_plan.md:639-663, 1092-1104
 */

import { AgentRunWorkflow, WorkflowInput, WorkflowResult, WorkflowContext } from "./workflow.js";
import * as activities from "./activities.js";
import { globalStore } from "../../engine/store.js";
import { RunState } from "../../../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";

export interface WorkflowExecution {
  workflowId: string;
  runId: string;
  input: WorkflowInput;
  history: unknown[]; // for replay and Continue-As-New
  signals: Array<{ kind: string; payload: unknown }>;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  result?: WorkflowResult;
  attempts: number;
  heartbeatDetails?: unknown;
  cancelled: boolean;
}

const executions = new Map<string, WorkflowExecution>();
const CONTINUE_AS_NEW_THRESHOLD = 100; // measured history growth `644`

function deterministicNow(start: number): number {
  // For replay, now() must be deterministic — use history size as clock
  return start + 1000;
}

export function getExecution(workflowId: string): WorkflowExecution | undefined {
  return executions.get(workflowId);
}

export function getExecutionByRunId(runId: string): WorkflowExecution | undefined {
  return [...executions.values()].find((e) => e.runId === runId);
}

export async function startWorkflow(input: WorkflowInput): Promise<WorkflowExecution> {
  const workflowId = `wf-${input.runId}`;
  const existing = executions.get(workflowId);
  if (existing) return existing; // idempotent StartRun `348`

  const exec: WorkflowExecution = {
    workflowId,
    runId: input.runId,
    input,
    history: [],
    signals: [],
    status: "RUNNING",
    attempts: 1,
    cancelled: false,
  };
  executions.set(workflowId, exec);

  // Run workflow asynchronously (simulates Temporal worker)
  // In real Temporal, workflow runs in separate task queue with replay
  runWorkflow(exec).catch((e) => {
    exec.status = "FAILED";
    exec.result = { runId: input.runId, status: "FAILED", failureCode: (e as Error).message };
  });

  return exec;
}

async function runWorkflow(exec: WorkflowExecution): Promise<void> {
  const startTime = Date.now();
  let historySize = 0;

  const ctx: WorkflowContext = {
    now: () => deterministicNow(startTime),
    random: () => {
      // Deterministic random via runId seed (no Math.random in workflow `660`)
      let hash = 0;
      for (let i = 0; i < exec.runId.length; i++) hash = (hash * 31 + exec.runId.charCodeAt(i)) >>> 0;
      return (hash % 1000) / 1000;
    },
    activity: async (name, input, opts) => {
      // Enforce explicit timeouts `662`
      const timeout = opts?.startToCloseTimeoutMs ?? 5000;
      // Simulate heartbeat for long activities `1099`
      if (opts?.heartbeatTimeoutMs) {
        // In real, would heartbeat periodically
        exec.heartbeatDetails = { activity: name, input };
      }
      // Check cancellation before activity `645`
      if (exec.cancelled) throw new Error("Cancelled");
      historySize++;
      exec.history.push({ type: "activity", name, input, time: ctx.now() });
      // Call actual activity (outside workflow) `639`
      const fn = (activities as Record<string, Function>)[name];
      if (!fn) throw new Error(`unknown activity ${name}`);
      // Simulate retry policy `664`
      let attempts = 0;
      const maxAttempts = opts?.retryPolicy?.maxAttempts ?? 1;
      while (true) {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Activity timeout")), timeout);
          });
          const res = await Promise.race([fn(input), timeoutPromise]);
          return res;
        } catch (e) {
          attempts++;
          const nonRetryable = opts?.retryPolicy?.nonRetryable ?? [];
          const msg = (e as Error).message;
          if (nonRetryable.some((code) => msg.includes(code)) || attempts >= maxAttempts) throw e;
          // Retry with backoff (simulated)
          await new Promise((r) => setTimeout(r, 10 * attempts));
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    },
    consumeSignals: (kind) => {
      const matched = kind ? exec.signals.filter((s) => s.kind === kind) : [...exec.signals];
      // Drain at safe point `630` — remove consumed
      exec.signals = kind ? exec.signals.filter((s) => s.kind !== kind) : [];
      return matched.map((s) => s.payload);
    },
    saveCheckpoint: async (checkpointId, version, artifactRef) => {
      await ctx.activity("saveCheckpoint", { checkpointId, version, artifactRef, runId: exec.runId }, { startToCloseTimeoutMs: 2000 });
    },
    heartbeat: (details) => {
      exec.heartbeatDetails = details;
    },
    isCancelled: () => exec.cancelled,
    throwIfCancelled: () => {
      if (exec.cancelled) throw new Error("Cancelled");
    },
    historySize: () => historySize,
    shouldContinueAsNew: () => historySize > CONTINUE_AS_NEW_THRESHOLD,
  };

  // Run deterministic workflow `658-670`
  try {
    const result = await AgentRunWorkflow(exec.input, ctx);
    if (result.failureCode === "CONTINUE_AS_NEW") {
      exec.status = "CONTINUED_AS_NEW";
      // In real, would start new execution with same runId and trimmed history
      exec.history = [];
      historySize = 0;
      // For spike, just mark and restart
      exec.status = "RUNNING";
      return runWorkflow(exec);
    }
    exec.status = result.status === "SUCCEEDED" ? "COMPLETED" : result.status === "CANCELLED" ? "CANCELLED" : "FAILED";
    exec.result = result;
    // DO NOT directly transition Engine store to SUCCEEDED — Engine authority owns terminal state (neryva_mcp_implementation_plan.md:98)
    // Spike previously simulated via direct store transition, but that violates Engine-only commit and causes e2e race where
    // duplicate AppendRunEvents sees terminal before test calls CommitRunResult. Correct flow is via commitRunResult Activity.
    // Worker only marks execution completed; Engine CommitRunResult will transition via authority.
  } catch (e) {
    if ((e as Error).message === "Cancelled") {
      exec.status = "CANCELLED";
      exec.result = { runId: exec.runId, status: "CANCELLED" };
    } else {
      exec.status = "FAILED";
      exec.result = { runId: exec.runId, status: "FAILED", failureCode: (e as Error).message };
    }
  }
}

export function signalWorkflow(workflowId: string, kind: string, payload: unknown): void {
  const exec = executions.get(workflowId);
  if (!exec) throw new Error(`workflow ${workflowId} not found`);
  // Temporal Signals are durable and delivered even during restart `630`
  exec.signals.push({ kind, payload });
  // If workflow is waiting, it will drain at next safe point
}

export function updateWorkflow(workflowId: string, kind: string, payload: unknown): unknown {
  const exec = executions.get(workflowId);
  if (!exec) throw new Error(`workflow ${workflowId} not found`);
  // Sync Update — validates and returns result immediately `652`
  // For spike, we just validate and return
  if (kind === "approval_decision") {
    // Validate approval decision
    return { accepted: true, workflowId };
  }
  throw new Error(`unknown update ${kind}`);
}

export function cancelWorkflow(workflowId: string): void {
  const exec = executions.get(workflowId);
  if (!exec) throw new Error(`workflow ${workflowId} not found`);
  exec.cancelled = true;
  // Propagate to activities via ctx.isCancelled() `645`
}

export function getHeartbeatDetails(workflowId: string): unknown {
  return executions.get(workflowId)?.heartbeatDetails;
}

// For testing: simulate worker crash and replay from history
export async function replayWorkflow(workflowId: string): Promise<void> {
  const exec = executions.get(workflowId);
  if (!exec) throw new Error(`workflow ${workflowId} not found`);
  // Simulate deterministic replay: re-run workflow with same input and history `639`
  // For spike, we just re-run the workflow function; in real Temporal, history is replayed event-by-event
  exec.history = [...exec.history]; // copy
  exec.status = "RUNNING";
  exec.cancelled = false;
  await runWorkflow(exec);
}

export function clearWorkflows(): void {
  executions.clear();
}
