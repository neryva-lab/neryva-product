/**
 * config.ts — runtime-control typed config, fail-closed
 * Source: agent_studio_implementation_plan.md:98-127 (stateless, internal, audited)
 */

import { z } from 'zod';

const EnvSchema = z.object({
  SERVICE_NAME: z.string().default('runtime-control'),
  BUILD_VERSION: z.string().default('0.1.0'),
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  NERYVA_MCP_ENDPOINT: z.string().url().default('http://localhost:50051'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('agent-studio-dev'),
  TEMPORAL_TASK_QUEUE: z.string().default('agent-run-default'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Execution mode: `temporal` starts AgentRunWorkflows through the Temporal
   * client; `inline` executes runs directly in this process via the inline
   * executor (dev / single-node deployments). Production must use temporal.
   */
  EXECUTION_MODE: z.enum(['temporal', 'inline']).default('inline'),
  /**
   * Shared service token for Engine → Studio RPC calls (Authorization: Bearer).
   * REQUIRED in production — the server fails closed without it.
   */
  NERYVA_SERVICE_TOKEN: z.string().min(16).optional(),
  // LiteLLM proxy (ADR-009): provider-neutral gateway over 100+ providers.
  LITELLM_BASE_URL: z.string().url().optional(),
  LITELLM_API_KEY: z.string().min(1).optional(),
  /** Default model reference (provider/model) when the manifest has none. */
  MODEL_GATEWAY__DEFAULT_MODEL: z
    .string()
    .regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/)
    .default('openai/gpt-4o-mini'),
  /**
   * Studio-side cost approximation for RunBudgets.max_cost_micros (FL-1.2):
   * micros charged per 1k tokens. 0 (default) = cost budget unmanaged here —
   * the Engine's usage ledger + quota reservations remain the billing
   * authority; Studio enforces tokens + wall-clock unconditionally.
   */
  MODEL_GATEWAY__COST_MICROS_PER_1K_TOKENS: z.coerce.number().min(0).default(0),
  // Harness guardrails (FL-1.4) — same provider contract as the Engine's port.
  HARNESS__MODERATION_PROVIDER: z.enum(['noop', 'openai_compatible']).default('noop'),
  HARNESS__MODERATION_BASE_URL: z.string().url().optional(),
  HARNESS__MODERATION_API_KEY: z.string().optional().default(''),
  HARNESS__MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  HARNESS__MODERATION_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
  HARNESS__WEB_SEARCH_URL: z.string().url().optional(),
  // FL-3.2 — hosted image generation endpoint for the generate_image builtin.
  HARNESS__IMAGE_GEN_URL: z.string().url().optional(),
});

export type Config = {
  serviceName: string;
  buildVersion: string;
  environment: 'development' | 'staging' | 'production';
  port: number;
  mcpEndpoint: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  logLevel: string;
  executionMode: 'temporal' | 'inline';
  serviceToken?: string | undefined;
  litellmBaseUrl?: string | undefined;
  litellmApiKey?: string | undefined;
  defaultModel: string;
  costMicrosPer1kTokens: number;
  guardrails: {
    moderationProvider: 'noop' | 'openai_compatible';
    moderationBaseUrl?: string | undefined;
    moderationApiKey?: string | undefined;
    moderationModel: string;
    moderationTimeoutMs: number;
    webSearchUrl?: string | undefined;
    imageGenUrl?: string | undefined;
  };
};

export function parseEnv(raw: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`config validation failed: ${parsed.error.message}`);
  }
  const env = parsed.data;
  if (env.ENVIRONMENT === 'production' && !env.NERYVA_SERVICE_TOKEN) {
    // Fail closed: an unauthenticated Engine → Studio control surface must
    // never boot in production.
    throw new Error('NERYVA_SERVICE_TOKEN is required when ENVIRONMENT=production');
  }
  return {
    serviceName: env.SERVICE_NAME,
    buildVersion: env.BUILD_VERSION,
    environment: env.ENVIRONMENT,
    port: env.PORT,
    mcpEndpoint: env.NERYVA_MCP_ENDPOINT,
    temporalAddress: env.TEMPORAL_ADDRESS,
    temporalNamespace: env.TEMPORAL_NAMESPACE,
    temporalTaskQueue: env.TEMPORAL_TASK_QUEUE,
    logLevel: env.LOG_LEVEL,
    executionMode: env.EXECUTION_MODE,
    serviceToken: env.NERYVA_SERVICE_TOKEN,
    litellmBaseUrl: env.LITELLM_BASE_URL,
    litellmApiKey: env.LITELLM_API_KEY,
    defaultModel: env.MODEL_GATEWAY__DEFAULT_MODEL,
    costMicrosPer1kTokens: env.MODEL_GATEWAY__COST_MICROS_PER_1K_TOKENS,
    guardrails: {
      moderationProvider: env.HARNESS__MODERATION_PROVIDER,
      moderationBaseUrl: env.HARNESS__MODERATION_BASE_URL || undefined,
      moderationApiKey: env.HARNESS__MODERATION_API_KEY || undefined,
      moderationModel: env.HARNESS__MODERATION_MODEL,
      moderationTimeoutMs: env.HARNESS__MODERATION_TIMEOUT_MS,
      webSearchUrl: env.HARNESS__WEB_SEARCH_URL || undefined,
      imageGenUrl: env.HARNESS__IMAGE_GEN_URL || undefined,
    },
  };
}

export function loadConfig(): Config {
  return parseEnv(process.env as Record<string, string | undefined>);
}
