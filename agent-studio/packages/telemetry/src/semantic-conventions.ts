/**
 * semantic-conventions.ts — GenAI OTel mapping, coalesce duplicate generations, do not sum tokens
 * Source: agent_studio_architecture.md:668-670 (GenAI conventions evolving; keep mapping in one module, coalesce duplicate generations, do not sum tokens, don't let business logic depend on experimental attribute names),
 * 1135-1162 (span hierarchy, W3C propagation), 1158 (usage from Engine ledger not span sums)
 */
export const GEN_AI_CONVENTIONS = {
  // Keep mapping centralized; experimental names not used in business logic
  'gen_ai.provider.name': 'gen_ai.provider.name',
  'gen_ai.model.name': 'gen_ai.model.name',
  'gen_ai.usage.input_tokens': 'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens': 'gen_ai.usage.output_tokens',
  'gen_ai.usage.total_tokens': 'gen_ai.usage.total_tokens',
  // Deprecated aliases that some SDKs still emit
  'ai.provider': 'gen_ai.provider.name',
  'ai.model': 'gen_ai.model.name',
} as const;

export interface UsageRecord {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  source: 'engine-ledger' | 'span';
}

export function coalesceUsage(records: UsageRecord[]): UsageRecord {
  // 670: coalesce equivalent spans rather than summing token counts
  // If multiple spans represent same provider call (e.g., framework emits two generations), keep max, not sum
  if (records.length === 0) return { source: 'span' };
  // Prefer engine-ledger as source of truth (1158)
  const ledger = records.find((r) => r.source === 'engine-ledger');
  if (ledger) return ledger;
  // Otherwise coalesce span records: take first non-empty, not sum
  const first = records.find((r) => r.inputTokens !== undefined || r.outputTokens !== undefined);
  if (first) return first;
  const fallback = records[0];
  if (!fallback) return { source: 'span' };
  return fallback;
}

export function normalizeProvider(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes('openai')) return 'openai';
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('google') || lower.includes('vertex') || lower.includes('gemini'))
    return 'google';
  return lower;
}

export function validateNoBusinessLogicOnExperimentalAttrs(attrs: Record<string, unknown>): void {
  // Business logic must not depend on experimental attribute names (668-670)
  const experimental = Object.keys(attrs).filter(
    (k) => k.startsWith('gen_ai.') && k.includes('experimental'),
  );
  if (experimental.length > 0)
    throw new Error(
      `business logic must not depend on experimental GenAI attrs: ${experimental.join(',')}`,
    );
}
