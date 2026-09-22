/**
 * sandbox.ts — isolated sandbox executor for untrusted/customer code, broad network, sensitive creds, high CPU
 * Source: agent_studio_architecture.md:400-405, agent_studio_implementation_plan.md:1018-1029, infra/policies/sandbox/
 * Controls: workload identity, FS isolation, CPU/mem/time limits, restricted egress, no ambient creds, audit.
 * Phase 6: stub that validates policy and simulates isolation; real implementation would use gVisor/Firecracker/Container.
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import type { ToolContext } from '../tool-context.js';

export interface SandboxLimits {
  cpuMs: number; // e.g., 5000
  memoryMb: number; // e.g., 512
  timeoutMs: number;
  egressAllowlist: string[];
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpuMs: 5000,
  memoryMb: 512,
  timeoutMs: 30_000,
  egressAllowlist: [],
};

export interface SandboxResult {
  success: boolean;
  result?: unknown | undefined;
  error?: string | undefined;
  audit: {
    toolId: string;
    organizationId: string;
    runId: string;
    egressAllowed: boolean;
    cpuMs: number;
    memoryMb: number;
  };
}

export async function executeInSandbox(
  descriptor: ToolDescriptor,
  args: unknown,
  ctx: ToolContext,
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
  limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): Promise<SandboxResult> {
  // Validate egress — sandbox must have explicit allowlist for open/limited
  const egressAllowed = descriptor.egressClass !== 'open' || limits.egressAllowlist.length > 0;

  // Validate no ambient credentials — handler must not have access to process.env
  // In real sandbox, env is stripped; here we just audit.

  // Enforce timeout
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`SANDBOX_TIMEOUT:${descriptor.toolId} after ${limits.timeoutMs}ms`)),
      limits.timeoutMs,
    );
  });

  try {
    const result = await Promise.race([handler(args, ctx), timeout]);
    return {
      success: true,
      result,
      audit: {
        toolId: descriptor.toolId,
        organizationId: ctx.organizationId,
        runId: ctx.runId,
        egressAllowed,
        cpuMs: limits.cpuMs,
        memoryMb: limits.memoryMb,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Check for escape attempt (simulated)
    if (msg.includes('escape') || msg.includes('process.env') || msg.includes('fs')) {
      return {
        success: false,
        error: `SANDBOX_ESCAPE_DENIED:${msg}`,
        audit: {
          toolId: descriptor.toolId,
          organizationId: ctx.organizationId,
          runId: ctx.runId,
          egressAllowed: false,
          cpuMs: limits.cpuMs,
          memoryMb: limits.memoryMb,
        },
      };
    }
    return {
      success: false,
      error: msg,
      audit: {
        toolId: descriptor.toolId,
        organizationId: ctx.organizationId,
        runId: ctx.runId,
        egressAllowed,
        cpuMs: limits.cpuMs,
        memoryMb: limits.memoryMb,
      },
    };
  }
}

// For tests: simulate escape attempt
export async function attemptSandboxEscape(): Promise<never> {
  throw new Error('escape: tried to access /etc/passwd');
}
