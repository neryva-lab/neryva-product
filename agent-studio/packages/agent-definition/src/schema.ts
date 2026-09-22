/**
 * schema.ts — Zod schema mirroring contracts/agent-definition/v1.schema.json
 * Source: agent_studio_architecture.md:357-405, agent_studio_implementation_plan.md:688-724
 * No `any` at boundaries; strict validation.
 */

import { z } from 'zod';

export const ModelPolicySchema = z.object({
  allowed_models: z
    .array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/))
    .min(1)
    .max(16),
  fallback_enabled: z.boolean().optional().default(false),
  max_output_tokens: z.number().int().min(1).max(128000).optional().default(4096),
});

export const ContextPolicySchema = z.object({
  history_limit: z.number().int().min(1).max(100).default(30),
  summary_enabled: z.boolean().default(true),
  knowledge_sources: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .max(16)
    .default([]),
  memory_scope: z.enum(['user', 'conversation', 'organization', 'none']).default('user'),
  max_context_tokens: z.number().int().min(1000).max(200000).optional().default(32000),
});

export const ToolSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .min(2)
    .max(64),
  access: z.enum(['read', 'write']),
  approval: z.enum(['required', 'none']).optional().default('none'),
});

export const GuardrailsSchema = z.object({
  input_policy: z.enum(['default', 'strict', 'permissive']).default('default'),
  output_policy: z.enum(['brand-safe', 'default', 'strict']).default('brand-safe'),
  pii_redaction: z.boolean().default(true),
});

export const BudgetPolicySchema = z.object({
  max_model_calls: z.number().int().min(1).max(32).optional().default(8),
  max_tool_calls: z.number().int().min(0).max(32).optional().default(8),
  max_wall_clock_ms: z.number().int().min(1000).max(3_600_000).optional().default(120_000),
  max_token_budget: z.number().int().min(1000).max(1_000_000).optional().default(50_000),
  max_cost_cents: z.number().int().min(1).max(100_000).optional().default(1000),
  max_recursion_depth: z.number().int().min(1).max(16).optional().default(5),
});

export const RetrievalPolicySchema = z.object({
  knowledge_max_results: z.number().int().min(1).max(20).optional().default(5),
  memory_max_results: z.number().int().min(0).max(20).optional().default(5),
  hybrid_retrieval: z.boolean().optional().default(false),
});

export const AgentDefinitionV1Schema = z
  .object({
    agent_id: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .min(3)
      .max(64),
    version: z.number().int().min(1),
    schema_version: z.literal('v1').optional().default('v1'),
    instructions: z.string().min(1).max(20000),
    model_policy: ModelPolicySchema,
    context_policy: ContextPolicySchema,
    tools: z.array(ToolSchema).max(32).default([]),
    guardrails: GuardrailsSchema,
    budget_policy: BudgetPolicySchema.optional().default({}),
    retrieval_policy: RetrievalPolicySchema.optional().default({}),
  })
  .strict();

export type AgentDefinitionV1 = z.infer<typeof AgentDefinitionV1Schema>;
export type AgentToolV1 = z.infer<typeof ToolSchema>;
