/**
 * sandbox.ts — tool-worker sandbox isolation (gVisor/Firecracker stub for Phase 6)
 * Source: agent_studio_architecture.md:400-405, infra/policies/sandbox/
 * Real implementation would use container with seccomp, no ambient creds, FS isolation, CPU/mem limits.
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import type { ToolContext } from '@neryva/tool-gateway';

export interface SandboxPolicy {
  cpuMs: number;
  memoryMb: number;
  timeoutMs: number;
  egressAllowlist: string[];
  workloadIdentity: string;
}

export async function runInSandbox(
  descriptor: ToolDescriptor,
  args: unknown,
  ctx: ToolContext,
  policy: SandboxPolicy,
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
): Promise<unknown> {
  // Validate no ambient credentials — handler should not capture process.env
  // In real sandbox, env is stripped and only scoped credential is injected
  const hasAmbient = typeof process !== 'undefined' && !!process.env['TOOL_AMBIENT_CREDENTIAL'];
  if (hasAmbient) throw new Error('SANDBOX_AMBIENT_CREDENTIAL_DETECTED');

  // Enforce egress allowlist
  if (descriptor.egressClass === 'open' && policy.egressAllowlist.length === 0) {
    throw new Error(
      `SANDBOX_EGRESS_DENIED:${descriptor.toolId} open egress not allowed without allowlist`,
    );
  }

  // Enforce timeout
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`SANDBOX_TIMEOUT:${descriptor.toolId}`)), policy.timeoutMs);
  });

  // Simulate FS isolation — handler cannot access /etc/passwd
  // In real, mount is read-only and isolated
  const result = await Promise.race([handler(args, ctx), timeout]);

  // Audit
  void policy.workloadIdentity;
  return result;
}
