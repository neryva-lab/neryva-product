/**
 * usage.ts — usage normalization + cost + tracing (usage via Engine/MCP, not local ledger)
 * Source: agent_studio_architecture.md:422, agent_studio_implementation_plan.md:877-886
 */

import type { NeryvaUsage } from '@neryva/contracts/provider/usage';
import { normalizeUsage, calculateCostCents } from '@neryva/contracts/provider/usage';
import type { NeryvaModelCapabilities } from './capabilities.js';

export interface UsageRecord {
  runId?: string | undefined;
  organizationId?: string | undefined;
  modelId: string;
  providerId: string;
  usage: NeryvaUsage;
  latencyMs?: number | undefined;
}

export function normalizeProviderUsage(raw: {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedTokens?: number | undefined;
  providerId?: string | undefined;
  modelId?: string | undefined;
}): NeryvaUsage {
  const prompt = raw.promptTokens ?? 0;
  const completion = raw.completionTokens ?? 0;
  // Some providers only report total — split heuristically if needed
  if (raw.totalTokens !== undefined && prompt === 0 && completion === 0) {
    return normalizeUsage({
      promptTokens: raw.totalTokens,
      completionTokens: 0,
      providerId: raw.providerId,
      modelId: raw.modelId,
      cachedTokens: raw.cachedTokens,
    });
  }
  return normalizeUsage({
    promptTokens: prompt,
    completionTokens: completion,
    providerId: raw.providerId,
    modelId: raw.modelId,
    cachedTokens: raw.cachedTokens,
  });
}

export function attachCost(usage: NeryvaUsage, cap: NeryvaModelCapabilities): NeryvaUsage {
  const costCents = calculateCostCents(usage, cap.cost);
  return { ...usage, costCents };
}

export function toEngineUsageRecord(params: {
  runId?: string;
  organizationId?: string;
  modelId: string;
  providerId: string;
  usage: NeryvaUsage;
  latencyMs?: number;
}): UsageRecord {
  return {
    runId: params.runId,
    organizationId: params.organizationId,
    modelId: params.modelId,
    providerId: params.providerId,
    usage: params.usage,
    latencyMs: params.latencyMs,
  };
}
