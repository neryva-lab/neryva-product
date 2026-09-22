/**
 * routing.ts — Engine snapshot → org allowlist → assistant policy → capability → health → adapter; fallback explicit, auditable
 * Source: agent_studio_architecture.md:909-918, 413
 * Never bypasses retention/residency.
 */

import type { NeryvaModelCapabilities, CapabilityRegistry } from './capabilities.js';
import type { ProviderAdapter } from './providers/provider.js';
import type { ModelCatalog, PolicySnapshot } from './model-catalog.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';

export interface RouteRequest {
  /** Desired model from agent definition (must be in capability registry) */
  requestedModel: string;
  /** Fallbacks from agent model_policy (explicit list) */
  fallbackModels?: string[] | undefined;
  /** Policy snapshot from Engine (org allowlist) */
  policySnapshot: PolicySnapshot;
  /** Whether fallback is allowed per definition */
  fallbackEnabled?: boolean | undefined;
  /** Budget/latency hints */
  hints?: { preferLatency?: boolean | undefined; maxCostCents?: number | undefined } | undefined;
}

export interface RouteResult {
  adapter: ProviderAdapter;
  modelId: string;
  capability: NeryvaModelCapabilities;
  fallbackUsed: boolean;
  attempted: string[];
  audit: {
    requested: string;
    selected: string;
    fallbackUsed: boolean;
    reason?: string | undefined;
  };
}

export function routeModel(params: {
  request: RouteRequest;
  catalog: ModelCatalog;
  adapters: Map<string, ProviderAdapter>; // providerId → adapter
  registry: CapabilityRegistry;
}): RouteResult {
  const { request, catalog, adapters, registry } = params;
  const attempted: string[] = [];
  const candidates = [
    request.requestedModel,
    ...(request.fallbackEnabled ? (request.fallbackModels ?? []) : []),
  ];

  for (const modelId of candidates) {
    attempted.push(modelId);
    const cap = registry.get(modelId);
    if (!cap) {
      // Unknown model — skip, not in registry (gating)
      continue;
    }
    // Org allowlist — must be allowed by policy snapshot
    if (!catalog.isAllowed(modelId, request.policySnapshot)) {
      continue;
    }
    // Capability — check availability/deprecation
    if (!cap.available || cap.deprecated) continue;
    // Health — adapter must be healthy
    const adapter = adapters.get(cap.providerId);
    if (!adapter || !adapter.isHealthy()) continue;
    // Cost/budget hint — if set, skip models exceeding maxCostCents (estimated)
    if (request.hints?.maxCostCents !== undefined) {
      const estimated = cap.cost.promptPer1kCents + cap.cost.completionPer1kCents;
      if (estimated > request.hints.maxCostCents) continue;
    }
    const fallbackUsed = modelId !== request.requestedModel;
    return {
      adapter,
      modelId,
      capability: cap,
      fallbackUsed,
      attempted,
      audit: {
        requested: request.requestedModel,
        selected: modelId,
        fallbackUsed,
        reason: fallbackUsed ? `fallback from ${request.requestedModel} to ${modelId}` : undefined,
      },
    };
  }

  // No candidate succeeded — explicit failure, not silent degrade
  throw new NeryvaProviderError({
    code: 'NOT_FOUND',
    message: `no route for ${request.requestedModel} (attempted: ${attempted.join(', ')}) — check org allowlist and capability registry`,
    retryable: false,
    providerId: undefined,
  });
}
