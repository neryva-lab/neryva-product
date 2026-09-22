/**
 * activity.ts — Activity executor (Temporal Activity boundary)
 * Source: agent_studio_implementation_plan.md:1018-1029, 786-799
 * Runs as Temporal Activity with heartbeat, timeout, retry (never blindly retry effectful).
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import type { ToolContext } from '../tool-context.js';

export interface ActivityExecutorOptions {
  heartbeatIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
}

export async function executeAsActivity(
  descriptor: ToolDescriptor,
  args: unknown,
  ctx: ToolContext,
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
  opts: ActivityExecutorOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? descriptor.timeoutMs;
  // In real Temporal, this would be an Activity with heartbeat. For Phase 6, we simulate with timeout.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`ACTIVITY_TIMEOUT:${descriptor.toolId}`)), timeoutMs);
  });
  return Promise.race([handler(args, ctx), timeout]);
}
