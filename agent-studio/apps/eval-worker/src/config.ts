/**
 * config.ts — eval-worker typed config, isolated budgets, synthetic data only
 * Source: 11.3 819, 1546 (isolated budget, marked test data, never mixes canonical), 533 (not production content)
 */
import { z } from 'zod';

const EnvSchema = z.object({
  SERVICE_NAME: z.string().default('eval-worker'),
  BUILD_VERSION: z.string().default('0.1.0'),
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  EVAL_DATASET_PATH: z.string().default('./tests/evaluation'),
  EVAL_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EVAL_BUDGET_TOKENS: z.coerce.number().int().positive().default(10000),
  EVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  NERYVA_MCP_ENDPOINT: z.string().url().default('http://localhost:50051'),
});

export type EvalConfig = {
  serviceName: string;
  buildVersion: string;
  environment: 'development' | 'staging' | 'production';
  datasetPath: string;
  maxConcurrency: number;
  budgetTokens: number;
  timeoutMs: number;
  mcpEndpoint: string;
};

export function parseEvalEnv(raw: Record<string, string | undefined>): EvalConfig {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`eval-worker config failed: ${parsed.error.message}`);
  const env = parsed.data;
  return {
    serviceName: env.SERVICE_NAME,
    buildVersion: env.BUILD_VERSION,
    environment: env.ENVIRONMENT,
    datasetPath: env.EVAL_DATASET_PATH,
    maxConcurrency: env.EVAL_MAX_CONCURRENCY,
    budgetTokens: env.EVAL_BUDGET_TOKENS,
    timeoutMs: env.EVAL_TIMEOUT_MS,
    mcpEndpoint: env.NERYVA_MCP_ENDPOINT,
  };
}

export function loadEvalConfig(): EvalConfig {
  return parseEvalEnv(process.env as Record<string, string | undefined>);
}
