/**
 * model-gateway.ts — provider-neutral gateway (single entrypoint)
 * Source: agent_studio_architecture.md:409-426, 442, 909-918
 * Provider adapters + capability registry + org allowlist + credentials + failover + rate limits + usage normalization + cost + redaction + tracing + error normalization.
 * Credentials only in activities via secret-provider (never in workflow/logs).
 */

import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type {
  NeryvaModelResponse,
  NeryvaStreamResult,
} from '@neryva/contracts/provider/model-response';
import type { NeryvaModelCapabilities } from './capabilities.js';
import { GLOBAL_CAPABILITY_REGISTRY } from './capabilities.js';
import type { CapabilityRegistry } from './capabilities.js';
import { createCatalog, type ModelCatalog, type PolicySnapshot } from './model-catalog.js';
import { routeModel } from './routing.js';
import type { ProviderAdapter } from './providers/provider.js';
import { createOpenAIAdapter } from './providers/openai.js';
import { createAnthropicAdapter } from './providers/anthropic.js';
import { createGoogleAdapter } from './providers/google.js';
import { createLiteLLMAdapter } from './providers/litellm.js';
import { withRetry, DEFAULT_RETRY_POLICY } from './retry-policy.js';
import { isProviderError, normalizeUnknownError } from './errors.js';
import { redactObject } from './redaction.js';
import { incrementCounter } from '@neryva/telemetry';
import type { SecretProvider } from '@neryva/security';

export interface GatewayOptions {
  catalog?: ModelCatalog | undefined;
  registry?: CapabilityRegistry | undefined;
  adapters?: Map<string, ProviderAdapter> | undefined;
  secretProvider?: SecretProvider | undefined;
  /** Model credentials map: providerId → SecretRef string */
  credentialRefs?: Record<string, string> | undefined;
  redactionMode?: 'strict' | 'permissive' | undefined;
  /**
   * Allow built-in test adapters with placeholder credentials (simulation mode).
   * Default true for tests/local; production wiring MUST pass false with a
   * secretProvider + credentialRefs so real credentials are resolved per call.
   */
  allowTestCredentials?: boolean | undefined;
}

export class ModelGateway {
  private readonly catalog: ModelCatalog;
  private readonly registry: CapabilityRegistry;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly allowTestCredentials: boolean;

  constructor(private readonly opts: GatewayOptions = {}) {
    this.registry = opts.registry ?? GLOBAL_CAPABILITY_REGISTRY;
    this.catalog = opts.catalog ?? createCatalog([...this.registry.list()]);
    this.allowTestCredentials = opts.allowTestCredentials ?? true;
    this.adapters = opts.adapters ?? this.createDefaultAdapters();
  }

  private createDefaultAdapters(): Map<string, ProviderAdapter> {
    const m = new Map<string, ProviderAdapter>();
    // Simulation adapters (placeholder key) only when explicitly allowed.
    // Production constructs the gateway with allowTestCredentials:false + credentialRefs,
    // so adapters are created lazily in ensureAdapter() with real per-call credentials.
    if (!this.allowTestCredentials) return m;
    const dummyKey = 'test-key';
    for (const factory of [createOpenAIAdapter, createAnthropicAdapter, createGoogleAdapter]) {
      try {
        const adapter = factory({ apiKey: dummyKey });
        m.set(adapter.providerId, adapter);
      } catch {
        // No provider if credential missing and not in test
      }
    }
    try {
      const litellm = createLiteLLMAdapter({ apiKey: dummyKey, baseUrl: 'http://localhost:4000' });
      m.set(litellm.providerId, litellm);
    } catch {
      // LiteLLM optional — still works without
    }
    return m;
  }

  /** Resolve credential via secret-provider only at call time (never at construction/log) */
  private async resolveApiKey(providerId: string): Promise<string> {
    const ref = this.opts.credentialRefs?.[providerId];
    if (!ref) {
      if (this.allowTestCredentials) return 'test-key'; // simulation mode only
      throw new Error(`PROVIDER_CREDENTIAL_MISSING:${providerId}`);
    }
    if (!this.opts.secretProvider) throw new Error(`secretProvider required for ${providerId}`);
    // Secret ref is providerId-specific, not per-model
    return this.opts.secretProvider.resolve({ ref });
  }

  /** Per-call credential resolver handed to adapters — rotation takes effect per call. */
  private apiKeyResolver(providerId: string): () => Promise<string> {
    return () => this.resolveApiKey(providerId);
  }

  /** Ensure adapter has credential (lazy re-create if needed) */
  private async ensureAdapter(providerId: string): Promise<ProviderAdapter> {
    const existing = this.adapters.get(providerId);
    if (existing) return existing;
    const hasRealCredential = this.opts.credentialRefs?.[providerId] !== undefined;
    const apiKey = await this.resolveApiKey(providerId);
    // getApiKey (real mode) is only wired when a real credential ref exists —
    // otherwise the adapter stays in simulation mode (test placeholder key).
    const factoryOpts = hasRealCredential
      ? { apiKey, getApiKey: () => this.resolveApiKey(providerId) }
      : { apiKey };
    if (providerId === 'openai') {
      const adapter = createOpenAIAdapter(factoryOpts);
      this.adapters.set(providerId, adapter);
      return adapter;
    }
    if (providerId === 'anthropic') {
      const adapter = createAnthropicAdapter(factoryOpts);
      this.adapters.set(providerId, adapter);
      return adapter;
    }
    if (providerId === 'google') {
      const adapter = createGoogleAdapter(factoryOpts);
      this.adapters.set(providerId, adapter);
      return adapter;
    }
    if (providerId === 'litellm') {
      const adapter = createLiteLLMAdapter(
        hasRealCredential
          ? { apiKey, getApiKey: () => this.resolveApiKey(providerId), baseUrl: 'http://localhost:4000' }
          : { apiKey, baseUrl: 'http://localhost:4000' },
      );
      this.adapters.set(providerId, adapter);
      return adapter;
    }
    throw new Error(`no adapter for provider ${providerId}`);
  }

  /** Main generate entry — routing + invocation + usage via caller (activities will RecordUsage via MCP) */
  async generate(
    gatewayRequest: NeryvaModelRequest & {
      policySnapshot?: PolicySnapshot | undefined;
      fallbackModels?: string[] | undefined;
      fallbackEnabled?: boolean | undefined;
    },
    callOpts?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaModelResponse> {
    const { policySnapshot, fallbackModels, fallbackEnabled, ...modelRequest } =
      gatewayRequest as NeryvaModelRequest & {
        policySnapshot?: PolicySnapshot;
        fallbackModels?: string[];
        fallbackEnabled?: boolean;
      };
    const snapshot: PolicySnapshot = policySnapshot ?? {
      organizationId: modelRequest.organizationId ?? 'unknown',
      allowedModels: [],
    };
    const route = routeModel({
      request: {
        requestedModel: modelRequest.model,
        fallbackModels,
        policySnapshot: snapshot,
        fallbackEnabled,
      },
      catalog: this.catalog,
      adapters: this.adapters,
      registry: this.registry,
    });

    // Ensure adapter has credential (lazy)
    const adapter = await this.ensureAdapter(route.adapter.providerId);

    // Fallback is explicit + auditable (never silent degrade) — 9.4
    if (route.fallbackUsed) {
      incrementCounter('model_route_fallback_total', {
        provider: route.adapter.providerId,
        requested: route.audit.requested,
        selected: route.audit.selected,
      });
    }

    // Redact for tracing (strict by default)
    const redactedReq = redactObject(modelRequest, this.opts.redactionMode ?? 'strict');
    void redactedReq;

    const start = Date.now();
    const doGenerate = async (): Promise<NeryvaModelResponse> => {
      try {
        const res = await adapter.generate({ ...modelRequest, model: route.modelId }, callOpts);
        // Attach latency
        return { ...res, latencyMs: Date.now() - start };
      } catch (e) {
        const norm = isProviderError(e) ? e : normalizeUnknownError(e, route.adapter.providerId);
        // Respect retry-after via retry-policy outer layer; here just normalize
        throw norm;
      }
    };

    // Gateway retry respects Retry-After; never blindly retry effectful (model is not side-effectful, so 2 attempts ok)
    return withRetry(doGenerate, DEFAULT_RETRY_POLICY, (e) => {
      if (isProviderError(e)) return e.retryable;
      return false;
    });
  }

  async stream(
    gatewayRequest: NeryvaModelRequest & {
      policySnapshot?: PolicySnapshot | undefined;
      fallbackModels?: string[] | undefined;
      fallbackEnabled?: boolean | undefined;
    },
    callOpts?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaStreamResult> {
    const { policySnapshot, fallbackModels, fallbackEnabled, ...modelRequest } =
      gatewayRequest as NeryvaModelRequest & {
        policySnapshot?: PolicySnapshot;
        fallbackModels?: string[];
        fallbackEnabled?: boolean;
      };
    const snapshot: PolicySnapshot = policySnapshot ?? {
      organizationId: modelRequest.organizationId ?? 'unknown',
      allowedModels: [],
    };
    const route = routeModel({
      request: {
        requestedModel: modelRequest.model,
        fallbackModels,
        policySnapshot: snapshot,
        fallbackEnabled,
      },
      catalog: this.catalog,
      adapters: this.adapters,
      registry: this.registry,
    });
    const adapter = await this.ensureAdapter(route.adapter.providerId);
    return adapter.stream({ ...modelRequest, model: route.modelId }, callOpts);
  }

  // Introspection for capability gating
  getCapabilities(modelId: string): NeryvaModelCapabilities | undefined {
    return this.registry.get(modelId);
  }

  listCapabilities(): NeryvaModelCapabilities[] {
    return this.registry.list();
  }

  /** For tests: inject adapter */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }
}
