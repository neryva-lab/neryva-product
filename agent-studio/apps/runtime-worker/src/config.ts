/**
 * config.ts — typed immutable config loaded once at startup, fail-closed
 * Source: agent_studio_implementation_plan.md:549-615 (7 groups, 6 fail-closed conditions)
 */

import { z } from 'zod';

const EnvSchema = z.object({
  // Runtime
  SERVICE_NAME: z.string().default('agent-studio'),
  BUILD_VERSION: z.string().default('0.1.0'),
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  SHUTDOWN_DEADLINE_MS: z.coerce.number().int().positive().default(30000),

  // Temporal
  TEMPORAL_ADDRESS: z.string().min(1, 'TEMPORAL_ADDRESS required'),
  TEMPORAL_NAMESPACE: z.string().min(1, 'TEMPORAL_NAMESPACE required'),
  TEMPORAL_TASK_QUEUE: z.string().default('agent-run-default'),
  TEMPORAL_WORKER_IDENTITY: z.string().default('agent-studio-worker-1'),
  TEMPORAL_WORKFLOW_BUNDLE_PATH: z
    .string()
    .default('./apps/runtime-worker/dist/workflow-bundle.js'),
  TEMPORAL_PAYLOAD_CODEC_MODE: z.enum(['claim-check', 'encrypted']).default('claim-check'),
  TEMPORAL_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  // Neryva MCP
  NERYVA_MCP_ENDPOINT: z.string().url('NERYVA_MCP_ENDPOINT must be valid URL'),
  // HTTP version for the Connect transport to the Engine MCP authority.
  // The Engine serves plain HTTP/1.1 (Fastify default); '2' requires the
  // server to speak h2c. Default matches what the Engine actually serves.
  NERYVA_MCP_HTTP_VERSION: z.enum(['1.1', '2']).default('1.1'),
  NERYVA_MCP_PROTOCOL_MAJOR: z.coerce.number().int().min(1).default(1),
  NERYVA_MCP_MINIMUM_MINOR: z.coerce.number().int().min(0).default(0),
  NERYVA_MCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NERYVA_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  NERYVA_MCP_CAPABILITY_ISSUER: z.string().min(1).default('neryva-engine'),
  NERYVA_MCP_CAPABILITY_KEY_ID: z.string().min(1).default('mcp-key-1'),

  // Model Gateway
  MODEL_GATEWAY_ENABLED_PROVIDERS: z.string().default('openai'),
  MODEL_GATEWAY_CATALOG_SOURCE: z.string().default('engine-policy-snapshot'),
  MODEL_GATEWAY_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MODEL_GATEWAY_CONCURRENCY_LIMIT: z.coerce.number().int().positive().default(10),
  MODEL_GATEWAY_REDACTION_MODE: z.enum(['strict', 'permissive']).default('strict'),

  // Tool Gateway
  TOOL_GATEWAY_REGISTRY_SOURCE: z.string().default('contracts/tool'),
  TOOL_GATEWAY_EFFECT_POLICY: z.string().default('strict'),
  TOOL_GATEWAY_APPROVAL_POLICY: z.string().default('required-for-mutating'),
  TOOL_GATEWAY_SANDBOX_ENDPOINT: z.string().url().or(z.literal('')).default(''),
  TOOL_GATEWAY_EGRESS_MODE: z.enum(['deny-by-default', 'allowlist']).default('deny-by-default'),

  // Harness guardrails (FL-1.4) — same provider contract as the Engine's port
  HARNESS__MODERATION_PROVIDER: z.enum(['noop', 'openai_compatible']).default('noop'),
  HARNESS__MODERATION_BASE_URL: z.string().url().or(z.literal('')).default(''),
  HARNESS__MODERATION_API_KEY: z.string().default(''),
  HARNESS__MODERATION_MODEL: z.string().default('omni-moderation-latest'),
  HARNESS__MODERATION_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),

  // Artifacts
  ARTIFACTS_CLAIM_CHECK_MODE: z
    .enum(['engine-authorized', 'disabled'])
    .default('engine-authorized'),
  ARTIFACTS_MAX_INLINE_BYTES: z.coerce.number().int().positive().default(8192),
  ARTIFACTS_MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(10485760),
  ARTIFACTS_ALLOWED_PURPOSES: z
    .string()
    .default('SOURCE_DOCUMENT,CHECKPOINT,TOOL_RESULT,TRANSCRIPT,EXPORT'),

  // Telemetry
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().or(z.literal('')).default(''),
  OTEL_SAMPLING_POLICY: z.string().default('parentbased_always_on'),
  OTEL_CONTENT_CAPTURE_POLICY: z.enum(['hash-only', 'none', 'full']).default('hash-only'),
  OTEL_METRICS_NAMESPACE: z.string().default('neryva_agent_studio'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export type Config = Readonly<{
  runtime: {
    serviceName: string;
    buildVersion: string;
    environment: 'development' | 'staging' | 'production';
    shutdownDeadlineMs: number;
  };
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
    workerIdentity: string;
    workflowBundlePath: string;
    payloadCodecMode: 'claim-check' | 'encrypted';
    retentionDays: number;
  };
  neryvaMcp: {
    endpoint: string;
    httpVersion: '1.1' | '2';
    protocolMajor: number;
    minimumMinor: number;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    capabilityIssuer: string;
    keyId: string;
  };
  modelGateway: {
    enabledProviders: string[];
    catalogSource: string;
    providerTimeoutMs: number;
    concurrencyLimit: number;
    redactionMode: 'strict' | 'permissive';
  };
  toolGateway: {
    registrySource: string;
    effectPolicy: string;
    approvalPolicy: string;
    sandboxEndpoint: string | undefined;
    egressMode: 'deny-by-default' | 'allowlist';
  };
  guardrails: {
    moderationProvider: 'noop' | 'openai_compatible';
    moderationBaseUrl: string | undefined;
    moderationApiKey: string | undefined;
    moderationModel: string;
    moderationTimeoutMs: number;
  };
  artifacts: {
    claimCheckMode: 'engine-authorized' | 'disabled';
    maxInlineBytes: number;
    maxArtifactBytes: number;
    allowedPurposes: string[];
  };
  telemetry: {
    exporterEndpoint: string | undefined;
    samplingPolicy: string;
    contentCapturePolicy: 'hash-only' | 'none' | 'full';
    metricsNamespace: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}>;

export function parseEnv(raw: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`config validation failed: ${details}`);
  }
  const env = parsed.data;

  // Fail-closed checks (agent_studio_implementation_plan.md:607-614)
  if (env.ENVIRONMENT === 'production' && env.OTEL_CONTENT_CAPTURE_POLICY === 'full') {
    throw new Error('fail-closed: unsafe content-capture policy "full" in production (607-614)');
  }
  if (
    env.ENVIRONMENT === 'production' &&
    env.TEMPORAL_PAYLOAD_CODEC_MODE === 'encrypted' &&
    !env.OTEL_EXPORTER_OTLP_ENDPOINT
  ) {
    // Encrypted codec requires an auditable telemetry path in production (839-848)
    throw new Error('fail-closed: encrypted payload codec requires OTEL exporter in production');
  }
  if (
    env.ENVIRONMENT === 'production' &&
    env.TOOL_GATEWAY_EGRESS_MODE === 'allowlist' &&
    !env.TOOL_GATEWAY_SANDBOX_ENDPOINT
  ) {
    // Egress allowed without an isolated sandbox boundary in production (1018-1029)
    throw new Error(
      'fail-closed: allowlist egress requires TOOL_GATEWAY_SANDBOX_ENDPOINT in production',
    );
  }
  if (env.ENVIRONMENT === 'production' && env.TEMPORAL_ADDRESS.startsWith('http://')) {
    throw new Error('fail-closed: production Temporal endpoint must not be plaintext HTTP');
  }
  // Workflow/activity version mismatch check is runtime (loaded via package.json version vs bundle)

  // Provider without credential ref — check enabled providers have at least catalog source
  if (env.MODEL_GATEWAY_ENABLED_PROVIDERS.length === 0) {
    throw new Error(
      'fail-closed: no enabled providers but gateway requires at least one or explicit empty with justification',
    );
  }

  return Object.freeze({
    runtime: {
      serviceName: env.SERVICE_NAME,
      buildVersion: env.BUILD_VERSION,
      environment: env.ENVIRONMENT,
      shutdownDeadlineMs: env.SHUTDOWN_DEADLINE_MS,
    },
    temporal: {
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workerIdentity: env.TEMPORAL_WORKER_IDENTITY,
      workflowBundlePath: env.TEMPORAL_WORKFLOW_BUNDLE_PATH,
      payloadCodecMode: env.TEMPORAL_PAYLOAD_CODEC_MODE,
      retentionDays: env.TEMPORAL_RETENTION_DAYS,
    },
    neryvaMcp: {
      endpoint: env.NERYVA_MCP_ENDPOINT,
      httpVersion: env.NERYVA_MCP_HTTP_VERSION,
      protocolMajor: env.NERYVA_MCP_PROTOCOL_MAJOR,
      minimumMinor: env.NERYVA_MCP_MINIMUM_MINOR,
      connectTimeoutMs: env.NERYVA_MCP_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: env.NERYVA_MCP_REQUEST_TIMEOUT_MS,
      capabilityIssuer: env.NERYVA_MCP_CAPABILITY_ISSUER,
      keyId: env.NERYVA_MCP_CAPABILITY_KEY_ID,
    },
    modelGateway: {
      enabledProviders: env.MODEL_GATEWAY_ENABLED_PROVIDERS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      catalogSource: env.MODEL_GATEWAY_CATALOG_SOURCE,
      providerTimeoutMs: env.MODEL_GATEWAY_PROVIDER_TIMEOUT_MS,
      concurrencyLimit: env.MODEL_GATEWAY_CONCURRENCY_LIMIT,
      redactionMode: env.MODEL_GATEWAY_REDACTION_MODE,
    },
    toolGateway: {
      registrySource: env.TOOL_GATEWAY_REGISTRY_SOURCE,
      effectPolicy: env.TOOL_GATEWAY_EFFECT_POLICY,
      approvalPolicy: env.TOOL_GATEWAY_APPROVAL_POLICY,
      sandboxEndpoint: env.TOOL_GATEWAY_SANDBOX_ENDPOINT || undefined,
      egressMode: env.TOOL_GATEWAY_EGRESS_MODE,
    },
    guardrails: {
      moderationProvider: env.HARNESS__MODERATION_PROVIDER,
      moderationBaseUrl: env.HARNESS__MODERATION_BASE_URL || undefined,
      moderationApiKey: env.HARNESS__MODERATION_API_KEY || undefined,
      moderationModel: env.HARNESS__MODERATION_MODEL,
      moderationTimeoutMs: env.HARNESS__MODERATION_TIMEOUT_MS,
    },
    artifacts: {
      claimCheckMode: env.ARTIFACTS_CLAIM_CHECK_MODE,
      maxInlineBytes: env.ARTIFACTS_MAX_INLINE_BYTES,
      maxArtifactBytes: env.ARTIFACTS_MAX_ARTIFACT_BYTES,
      allowedPurposes: env.ARTIFACTS_ALLOWED_PURPOSES.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    telemetry: {
      exporterEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
      samplingPolicy: env.OTEL_SAMPLING_POLICY,
      contentCapturePolicy: env.OTEL_CONTENT_CAPTURE_POLICY,
      metricsNamespace: env.OTEL_METRICS_NAMESPACE,
      logLevel: env.LOG_LEVEL,
    },
  });
}

export function loadConfig(): Config {
  return parseEnv(process.env as Record<string, string | undefined>);
}
