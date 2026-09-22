/**
 * sandbox.ts — SIMULATED sandbox executor. NO real isolation.
 *
 * Ground truth (Wave 3, 2026-09-23): the handler runs IN-PROCESS — same
 * Node.js process, same V8 isolate, same event loop as the gateway. Empirically
 * verified: a handler executed here can read /etc/passwd, read process.env,
 * and write files outside any sandbox root.
 *
 * What IS enforced:
 * - wall-clock timeout via Promise.race. The handler is NOT cancelled, killed,
 *   or disposed on timeout — it keeps running in the background.
 * - static policy validation: `egressClass: 'open'` requires a non-empty
 *   egress allowlist. This is validated, NOT network-enforced.
 * - refusal to run when the single env var TOOL_AMBIENT_CREDENTIAL is set.
 * - an audit record, marked `sandboxKind: 'simulated'`.
 *
 * What is NOT enforced: filesystem isolation, network egress restriction,
 * CPU/memory limits, environment stripping, process separation, escape
 * detection. The `cpuMs`/`memoryMb` values in the audit record are the
 * configured policy values, not measured or enforced limits.
 *
 * Do NOT route genuinely untrusted code through this executor.
 *
 * TODO(owner: release loop): replace with HttpSandboxExecutor against a
 * deployed E2B-OSS/Daytona backend per
 * docs/design/fl-2.11-sandbox-code-interpreter.md, and fail closed with
 * SANDBOX_UNCONFIGURED when no backend is configured. Until then,
 * `executionMode: 'sandbox'` tools silently execute in-process.
 *
 * Source: agent_studio_architecture.md:400-405, agent_studio_implementation_plan.md:1018-1029, infra/policies/sandbox/
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import type { ToolContext } from '../tool-context.js';

export interface SimulatedSandboxLimits {
  cpuMs: number; // e.g., 5000 — policy value only; NOT enforced
  memoryMb: number; // e.g., 512 — policy value only; NOT enforced
  timeoutMs: number;
  egressAllowlist: string[];
}

export const DEFAULT_SIMULATED_SANDBOX_LIMITS: SimulatedSandboxLimits = {
  cpuMs: 5000,
  memoryMb: 512,
  timeoutMs: 30_000,
  egressAllowlist: [],
};

export interface SimulatedSandboxResult {
  success: boolean;
  result?: unknown | undefined;
  error?: string | undefined;
  audit: {
    sandboxKind: 'simulated';
    toolId: string;
    organizationId: string;
    runId: string;
    egressAllowed: boolean;
    cpuMs: number;
    memoryMb: number;
  };
}

function auditBase(
  descriptor: ToolDescriptor,
  ctx: ToolContext,
  egressAllowed: boolean,
  limits: SimulatedSandboxLimits,
): SimulatedSandboxResult['audit'] {
  return {
    sandboxKind: 'simulated',
    toolId: descriptor.toolId,
    organizationId: ctx.organizationId,
    runId: ctx.runId,
    egressAllowed,
    cpuMs: limits.cpuMs,
    memoryMb: limits.memoryMb,
  };
}

export async function executeInSimulatedSandbox(
  descriptor: ToolDescriptor,
  args: unknown,
  ctx: ToolContext,
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
  limits: SimulatedSandboxLimits = DEFAULT_SIMULATED_SANDBOX_LIMITS,
): Promise<SimulatedSandboxResult> {
  // Refuse when the ambient-credential marker is present. This checks one env
  // var only — the rest of process.env remains fully visible to the handler.
  if (typeof process !== 'undefined' && process.env['TOOL_AMBIENT_CREDENTIAL']) {
    return {
      success: false,
      error: `SIMULATED_SANDBOX_AMBIENT_CREDENTIAL_DETECTED:${descriptor.toolId}`,
      audit: auditBase(descriptor, ctx, false, limits),
    };
  }

  // Validate egress — static policy check only. `open` egress requires an
  // explicit allowlist; nothing inspects or blocks actual network traffic.
  const egressAllowed = descriptor.egressClass !== 'open' || limits.egressAllowlist.length > 0;
  if (!egressAllowed) {
    return {
      success: false,
      error: `SIMULATED_SANDBOX_EGRESS_DENIED:${descriptor.toolId} open egress not allowed without allowlist`,
      audit: auditBase(descriptor, ctx, false, limits),
    };
  }

  // Enforce timeout. NOTE: Promise.race does not cancel the handler — a
  // timed-out handler keeps executing in this process.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(new Error(`SIMULATED_SANDBOX_TIMEOUT:${descriptor.toolId} after ${limits.timeoutMs}ms`)),
      limits.timeoutMs,
    );
  });

  try {
    const result = await Promise.race([handler(args, ctx), timeout]);
    return {
      success: true,
      result,
      audit: auditBase(descriptor, ctx, egressAllowed, limits),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg,
      audit: auditBase(descriptor, ctx, egressAllowed, limits),
    };
  }
}
