/**
 * model-request.ts — NeryvaModelRequest (provider-neutral, bounded)
 * Source: agent_studio_architecture.md:432-439, agent_studio_implementation_plan.md:862-886
 * Never expose Vercel AI SDK or provider SDK types as public contract.
 */

import { z } from 'zod';
import { NeryvaToolCallSchema } from './tool-call.js';

/**
 * FL-1.6 — multimodal content part. `image` data arrives as claim-check
 * fetched bytes (base64-encoded for the wire-agnostic contract); the gateway
 * adapters map it to the provider's native image part shape.
 */
export const NeryvaImagePartSchema = z.object({
  type: z.literal('image'),
  /** IANA media type — the knowledge plane allowlist gates accepted values. */
  mediaType: z.string().min(1).max(128),
  /** Raw image bytes (base64-encoded). */
  data: z.string().min(1),
});

export const NeryvaContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().min(1).max(100_000) }),
  NeryvaImagePartSchema,
]);

export type NeryvaContentPart = z.infer<typeof NeryvaContentPartSchema>;

export const NeryvaMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string().min(1).max(100_000),
    z.array(NeryvaContentPartSchema).min(1).max(8),
  ]),
  /** For assistant tool-call messages */
  toolCalls: z.array(NeryvaToolCallSchema).optional(),
  /** For tool result messages */
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});

export type NeryvaMessage = z.infer<typeof NeryvaMessageSchema>;

export const NeryvaToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(2000),
  /** JSON Schema for args */
  parameters: z.record(z.unknown()).optional(),
  inputSchema: z.record(z.unknown()).optional(),
});

export type NeryvaTool = z.infer<typeof NeryvaToolSchema>;

export const NeryvaStructuredOutputSchema = z.object({
  /** JSON Schema for structured output */
  schema: z.record(z.unknown()),
  /** Name for the structured output (e.g., function name) */
  name: z.string().optional(),
  description: z.string().optional(),
  /** Whether to enforce strict JSON schema */
  strict: z.boolean().optional(),
});

export type NeryvaStructuredOutput = z.infer<typeof NeryvaStructuredOutputSchema>;

export const NeryvaModelRequestSchema = z.object({
  /** Model id as in capability registry, e.g., openai/gpt-4o-mini */
  model: z.string().min(1).max(128),
  /** Ordered messages — bounded, claim-check for large history */
  messages: z.array(NeryvaMessageSchema).min(1).max(128),
  /** Tools available for this call (bounded, allowlisted) */
  tools: z.array(NeryvaToolSchema).max(32).optional(),
  /** How model may use tools */
  toolChoice: z.enum(['auto', 'none', 'required']).optional(),
  /** Structured output request (e.g., JSON mode) */
  structuredOutput: NeryvaStructuredOutputSchema.optional(),
  /** Sampling */
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  /** Max output tokens (provider enforces context limits) */
  maxTokens: z.number().int().positive().max(128_000).optional(),
  /** Whether to stream */
  stream: z.boolean().optional(),
  /** Timeout in ms (gateway enforces) */
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  /** Seed for deterministic output where supported */
  seed: z.number().int().optional(),
  /** Tenant/run correlation for tracing */
  correlationId: z.string().optional(),
  runId: z.string().optional(),
  organizationId: z.string().optional(),
  /** For redaction tracking */
  metadata: z.record(z.unknown()).optional(),
});

export type NeryvaModelRequest = z.infer<typeof NeryvaModelRequestSchema>;

/**
 * Flatten message content to plain text — text parts joined, image parts
 * dropped. Used by text-only surfaces (simulation adapters, logging, hashes);
 * multimodal consumers read the parts directly.
 */
export function messageText(content: NeryvaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<NeryvaContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function validateModelRequest(req: unknown): NeryvaModelRequest {
  return NeryvaModelRequestSchema.parse(req);
}
