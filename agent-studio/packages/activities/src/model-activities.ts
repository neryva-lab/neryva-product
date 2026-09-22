/**
 * model-activities.ts — Model Gateway invocation as Activity (credentials only here)
 * Source: agent_studio_implementation_plan.md:862-886, 408-426, 1427
 * Credentials via @neryva/security secret-provider, never in workflow/logs/definitions/capability claims.
 * Usage via Engine/MCP, not local ledger (gateway normalizes, activities record).
 */

import { heartbeat, isActivityCancelled } from './heartbeat.js';
import { ModelGateway } from '@neryva/model-gateway';
import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type { NeryvaModelResponse } from '@neryva/contracts/provider/model-response';
import type { SecretProvider, SecretRef } from '@neryva/security';

export interface ModelActivitiesOptions {
  gateway: ModelGateway;
  secretProvider?: SecretProvider | undefined;
}

export interface ModelCallParams extends Omit<NeryvaModelRequest, 'model'> {
  model?: string | undefined;
  runId: string;
  stepId: string;
  organizationId: string;
  agentVersionId: string;
  correlationId?: string | undefined;
  // Policy snapshot for routing (org allowlist)
  policySnapshot?: { organizationId: string; allowedModels: string[] } | undefined;
}

export interface ModelCallResult extends NeryvaModelResponse {
  stepId: string;
}

/**
 * Single Model Gateway Activity — gateway handles routing, redaction, retry, usage normalization, cost.
 * Workflow calls this via proxyActivities; Activity handles network + credentials + heartbeat.
 */
export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  heartbeat({ step: 'callModel:start', runId: params.runId, stepId: params.stepId });
  if (isActivityCancelled()) {
    const { NeryvaProviderError } = await import('@neryva/contracts/provider/errors');
    throw new NeryvaProviderError({
      code: 'CANCELLED',
      message: 'cancelled before model call',
      retryable: false,
      providerId: undefined,
    });
  }

  // Build gateway request — merge NeryvaModelRequest with routing context
  // In production, gateway would resolve secret via secretProvider at call time (not in workflow)
  // For tests, gateway is created with dummy key; secretProvider is optional
  const gateway = getGateway(params);
  const effectiveModel = params.model ?? 'openai/gpt-4o-mini';
  const request: NeryvaModelRequest & Record<string, unknown> = {
    model: effectiveModel,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    structuredOutput: params.structuredOutput,
    temperature: params.temperature,
    topP: params.topP,
    maxTokens: params.maxTokens,
    stream: params.stream,
    timeoutMs: params.timeoutMs,
    correlationId: params.correlationId ?? params.runId,
    runId: params.runId,
    organizationId: params.organizationId,
    policySnapshot: params.policySnapshot,
  } as NeryvaModelRequest & Record<string, unknown>;

  // Heartbeat during generation
  const result = await gateway.generate(request, { signal: undefined });
  heartbeat({ step: 'callModel:done', runId: params.runId, finishReason: result.finishReason });

  // Usage is normalized by gateway (costCents attached); activities will RecordUsage via MCP separately
  // Here we just return result; caller (workflow) will appendRunEvents and Activities will recordUsage in next step
  return { ...result, stepId: params.stepId };
}

// For tests without DI, use global gateway singleton (created with dummy openai adapter)
let globalGateway: ModelGateway | undefined;
function getGateway(params: ModelCallParams): ModelGateway {
  // If caller passed gateway via param (for DI), use it; else global
  // We store gateway on params via hidden field for test injection — simpler: use global
  if ((params as unknown as { __gateway?: ModelGateway }).__gateway) {
    return (params as unknown as { __gateway: ModelGateway }).__gateway;
  }
  if (!globalGateway) globalGateway = new ModelGateway();
  return globalGateway;
}

/**
 * REL-1.5 (engine release_ledger.md) — Engine-side credential disclosure
 * adapter. The Engine discloses model-provider keys ONLY through its audited
 * GetToolCredential RPC under the pseudo-tool name `model:<provider>` — the
 * SecretRef IS that pseudo-tool name, resolved per call (never cached, never
 * logged). An empty credential means the run's manifest does not pin the
 * provider or the org has no active key: fail loudly as
 * PROVIDER_CREDENTIAL_MISSING instead of silently sending no auth.
 */
export class EngineSecretProvider implements SecretProvider {
  constructor(private readonly client: EngineCredentialClient) {}
  async resolve(ref: SecretRef): Promise<string> {
    const response = (await this.client.getToolCredential({ toolName: ref.ref })) as { credential?: unknown } | null;
    const credential = typeof response?.credential === 'string' ? response.credential : '';
    if (credential.length === 0) {
      throw new Error(
        `PROVIDER_CREDENTIAL_MISSING: engine disclosed no credential for ${ref.ref} — pin the provider on the run manifest and provision a key`,
      );
    }
    return credential;
  }
}

/** REL-1.5 — structural surface satisfied by NeryvaMcpClient (no package dependency needed). */
export interface EngineCredentialClient {
  getToolCredential(params: { toolName: string }): Promise<unknown>;
}

/** REL-1.5 — every providerId resolves to the Engine disclosure rail `model:<providerId>`. */
export function engineCredentialRefs(): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get: (_target, providerId) => `model:${String(providerId)}`,
  });
}

export function createModelActivities(gateway?: ModelGateway, secretProvider?: SecretProvider) {
  if (gateway) globalGateway = gateway;
  // REL-1.5 — production construction: no test adapters, every provider key
  // resolved per call through the Engine's audited disclosure rail.
  if (!gateway && secretProvider) {
    globalGateway = new ModelGateway({
      allowTestCredentials: false,
      secretProvider,
      credentialRefs: engineCredentialRefs(),
    });
  }
  if (!globalGateway) globalGateway = new ModelGateway();
  return { callModel };
}

export type ModelActivities = ReturnType<typeof createModelActivities>;
