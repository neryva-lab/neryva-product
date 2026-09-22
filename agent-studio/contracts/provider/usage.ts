/**
 * usage.ts — normalized Neryva usage (provider-agnostic, costed)
 * Source: agent_studio_architecture.md:422, 669, agent_studio_implementation_plan.md:877-886
 * Normalized from provider-specific usage; recorded via Engine/MCP, not local ledger.
 */

import { z } from 'zod';

export const NeryvaUsageSchema = z.object({
  /** Input (prompt + system + tools + messages) tokens */
  promptTokens: z.number().int().min(0),
  /** Output (completion) tokens */
  completionTokens: z.number().int().min(0),
  /** Total = prompt + completion, must match sum */
  totalTokens: z.number().int().min(0),
  /** Cached prompt tokens if provider reports (e.g., OpenAI cached) */
  cachedTokens: z.number().int().min(0).optional(),
  /** Reasoning tokens if provider reports */
  reasoningTokens: z.number().int().min(0).optional(),
  /** Normalized cost in USD cents (integer to avoid float) */
  costCents: z.number().int().min(0).optional(),
  /** Currency */
  currency: z.string().default('USD').optional(),
  /** Provider identifier that reported original usage */
  providerId: z.string().optional(),
  /** Model that generated this usage */
  modelId: z.string().optional(),
});

export type NeryvaUsage = z.infer<typeof NeryvaUsageSchema>;

export function normalizeUsage(params: {
  promptTokens: number;
  completionTokens: number;
  providerId?: string | undefined;
  modelId?: string | undefined;
  cachedTokens?: number | undefined;
}): NeryvaUsage {
  const total = params.promptTokens + params.completionTokens;
  return {
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens: total,
    cachedTokens: params.cachedTokens,
    providerId: params.providerId,
    modelId: params.modelId,
  };
}

/** Cost calculation — simple per-1k token rates; production uses catalog per model */
export function calculateCostCents(
  usage: NeryvaUsage,
  rates: { promptPer1kCents: number; completionPer1kCents: number },
): number {
  const promptCost = (usage.promptTokens / 1000) * rates.promptPer1kCents;
  const completionCost = (usage.completionTokens / 1000) * rates.completionPer1kCents;
  return Math.round(promptCost + completionCost);
}
