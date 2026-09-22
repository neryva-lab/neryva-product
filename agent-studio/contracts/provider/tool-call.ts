/**
 * tool-call.ts — Neryva provider-neutral tool call (never raw provider type)
 * Source: agent_studio_architecture.md:432-439, agent_studio_implementation_plan.md:862-886
 * Gateway owns this contract; provider adapters map to/from it.
 */

import { z } from 'zod';

export const NeryvaToolCallSchema = z.object({
  /** Stable tool call id assigned by provider or gateway */
  id: z.string().min(1).max(128),
  /** Tool name as registered in Tool Gateway (must be allowlisted) */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  /** Arguments as JSON value — validated against ToolDescriptor inputSchema in gateway */
  args: z.unknown(),
  /** Optional: raw args JSON string for debugging (redacted in traces) */
  argsJson: z.string().optional(),
});

export type NeryvaToolCall = z.infer<typeof NeryvaToolCallSchema>;

export const NeryvaToolResultSchema = z.object({
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  /** Result payload — bounded; large results must be claim-check */
  result: z.unknown(),
  /** Whether tool execution succeeded */
  success: z.boolean(),
  /** Optional error code for failed tools */
  errorCode: z.string().optional(),
});

export type NeryvaToolResult = z.infer<typeof NeryvaToolResultSchema>;
