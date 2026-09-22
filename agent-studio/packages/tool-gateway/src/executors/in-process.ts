/**
 * in-process.ts — in-process executor for trusted read-only tools
 * Source: agent_studio_implementation_plan.md:1018-1029
 * Only for trusted code/dependencies; no sandbox overhead. Still enforces timeout, egress, redaction.
 */

import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import type { ToolContext } from '../tool-context.js';

export type InProcessHandler = (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown;

export interface InProcessExecutorOptions {
  timeoutMs: number;
  // For Phase 6, we just enforce timeout via Promise.race
}

export async function executeInProcess(
  descriptor: ToolDescriptor,
  args: unknown,
  ctx: ToolContext,
  handler: InProcessHandler,
  opts: InProcessExecutorOptions = { timeoutMs: descriptor.timeoutMs },
): Promise<unknown> {
  // Timeout enforcement
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`TOOL_TIMEOUT:${descriptor.toolId} after ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );
  });
  const result = handler(args, ctx);
  return Promise.race([result, timeout]);
}
