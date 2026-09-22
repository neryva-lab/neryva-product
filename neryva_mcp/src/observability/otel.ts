/**
 * OTel GenAI — centralized mapping, coalesce duplicate SPAN generations not sum tokens.
 * Reference: neryva_mcp_implementation_plan.md:873, 898-905
 */

const GEN_AI_ATTRS = {
  // Centralized mapping — keep business logic off experimental attribute names
  "gen_ai.request.model": "model",
  "gen_ai.usage.input_tokens": "inputTokens",
  "gen_ai.usage.output_tokens": "outputTokens",
  // ... etc, centralized
} as const;

export function mapGenAiSpan(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [otelKey, internalKey] of Object.entries(GEN_AI_ATTRS)) {
    if (internalKey in attrs) out[otelKey] = attrs[internalKey as string];
  }
  return out;
}

export function coalesceTokenCounts(spans: Array<{ inputTokens: number; outputTokens: number }>): { inputTokens: number; outputTokens: number } {
  // Do not sum duplicate SPAN generations — coalesce
  const seen = new Set<string>();
  let input = 0;
  let output = 0;
  for (const s of spans) {
    const key = `${s.inputTokens}:${s.outputTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    input += s.inputTokens;
    output += s.outputTokens;
  }
  return { inputTokens: input, outputTokens: output };
}

export function shouldNotUseExperimentalAttribute(attr: string): boolean {
  return attr.startsWith("gen_ai.experimental.");
}
