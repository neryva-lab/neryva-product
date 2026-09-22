/**
 * config.ts — tool-worker typed config, fail-closed, isolated egress
 * Source: agent_studio_implementation_plan.md:536-547, 1018-1029
 */

import { z } from 'zod';

const EnvSchema = z.object({
  SERVICE_NAME: z.string().default('tool-worker'),
  BUILD_VERSION: z.string().default('0.1.0'),
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('agent-studio-dev'),
  TEMPORAL_TASK_QUEUE: z.string().default('tool-effectful'),
  TEMPORAL_WORKER_IDENTITY: z.string().default('tool-worker-1'),
  TOOL_EGRESS_MODE: z.enum(['deny-by-default', 'allowlist']).default('deny-by-default'),
  TOOL_SANDBOX_CPU_MS: z.coerce.number().int().positive().default(5000),
  TOOL_SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(512),
  TOOL_SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().or(z.literal('')).default(''),
});

export type Config = {
  serviceName: string;
  buildVersion: string;
  environment: 'development' | 'staging' | 'production';
  temporal: { address: string; namespace: string; taskQueue: string; workerIdentity: string };
  sandbox: {
    cpuMs: number;
    memoryMb: number;
    timeoutMs: number;
    egressMode: 'deny-by-default' | 'allowlist';
  };
  telemetry: { exporterEndpoint: string | undefined };
};

export function parseEnv(raw: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`config validation failed: ${parsed.error.message}`);
  const env = parsed.data;
  return {
    serviceName: env.SERVICE_NAME,
    buildVersion: env.BUILD_VERSION,
    environment: env.ENVIRONMENT,
    temporal: {
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workerIdentity: env.TEMPORAL_WORKER_IDENTITY,
    },
    sandbox: {
      cpuMs: env.TOOL_SANDBOX_CPU_MS,
      memoryMb: env.TOOL_SANDBOX_MEMORY_MB,
      timeoutMs: env.TOOL_SANDBOX_TIMEOUT_MS,
      egressMode: env.TOOL_EGRESS_MODE,
    },
    telemetry: { exporterEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined },
  };
}

export function loadConfig(): Config {
  return parseEnv(process.env as Record<string, string | undefined>);
}
