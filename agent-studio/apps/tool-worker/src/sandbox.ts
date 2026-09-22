/**
 * sandbox.ts — SIMULATED sandbox for the tool-worker pool. NO real isolation.
 *
 * Ground truth (Wave 3, 2026-09-23): the handler runs IN-PROCESS — same
 * Node.js process, same V8 isolate as the worker. There is no filesystem
 * isolation (a handler CAN read /etc/passwd), no network enforcement, no
 * CPU/memory limits, and no environment stripping beyond the single
 * TOOL_AMBIENT_CREDENTIAL check below.
 *
 * What IS enforced:
 * - wall-clock timeout via Promise.race. The handler is NOT cancelled or
 *   killed on timeout — it keeps running in the background.
 * - static policy validation: `egressClass: 'open'` requires a non-empty
 *   egress allowlist (validated, not network-enforced).
 * - refusal to run when TOOL_AMBIENT_CREDENTIAL is set (one env var only).
 *
 * Do NOT route genuinely untrusted code through this function.
 *
 * TODO(owner: release loop): replace with a real sandbox backend (E2B OSS /
 * Daytona via HTTP) per docs/design/fl-2.11-sandbox-code-interpreter.md.
 *
 * Source: agent_studio_architecture.md:400-405, infra/policies/sandbox/
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import type { ToolContext } from '@neryva/tool-gateway';

export interface SimulatedSandboxPolicy {
  cpuMs: number; // policy value only; NOT enforced
  memoryMb: number; // policy value only; NOT enforced
  timeoutMs: number;
  egressAllowlist: string[];
  workloadIdentity: string;
}

export async function runInSimulatedSandbox(
  descriptor: ToolDescriptor,
  args: unknown,
  ctx: ToolContext,
  policy: SimulatedSandboxPolicy,
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
): Promise<unknown> {
  // Refuse when the ambient-credential marker is present. This checks one env
  // var only — the rest of process.env remains fully visible to the handler.
  const hasAmbient = typeof process !== 'undefined' && !!process.env['TOOL_AMBIENT_CREDENTIAL'];
  if (hasAmbient) throw new Error('SIMULATED_SANDBOX_AMBIENT_CREDENTIAL_DETECTED');

  // Validate egress allowlist — static policy check only; no network enforcement.
  if (descriptor.egressClass === 'open' && policy.egressAllowlist.length === 0) {
    throw new Error(
      `SIMULATED_SANDBOX_EGRESS_DENIED:${descriptor.toolId} open egress not allowed without allowlist`,
    );
  }

  // Enforce timeout. NOTE: Promise.race does not cancel the handler — a
  // timed-out handler keeps executing in this process.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`SIMULATED_SANDBOX_TIMEOUT:${descriptor.toolId}`)),
      policy.timeoutMs,
    );
  });

  const result = await Promise.race([handler(args, ctx), timeout]);

  // Audit
  void policy.workloadIdentity;
  return result;
}
