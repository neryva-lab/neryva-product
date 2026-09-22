/**
 * validator.ts — domain validation (7 rejection classes)
 * Source: agent_studio_implementation_plan.md:725-732
 * Must reject before publish; all are typed StudioError with non-retryable.
 */

import { StudioError } from '@neryva/agent-kernel';
import type { AgentDefinitionV1 } from './schema.js';
import {
  validateAllowedModels,
  isKnownTool,
  getToolDescriptor,
  DEFAULT_MODEL_CAPABILITIES,
} from './capability-checker.js';
import type { ToolDescriptor } from '../../../contracts/tool/descriptor.js';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  PLATFORM_BUILT_IN_TOOLS,
} from '../../../contracts/tool/descriptor.js';

export type ValidationErrorCode =
  | 'UNKNOWN_CAPABILITY'
  | 'UNKNOWN_TOOL'
  | 'EFFECTFUL_WITHOUT_APPROVAL'
  | 'LIMITS_EXCEED_ENTITLEMENT'
  | 'UNSUPPORTED_CONTEXT'
  | 'UNBOUNDED_RECURSION'
  | 'INSTRUCTIONS_ENGINE_AUTHORITY';

export interface ValidationOptions {
  modelRegistry?: Set<string>;
  toolRegistry?: ToolDescriptor[];
  entitlements?: { maxModelCalls?: number; maxToolCalls?: number; maxCostCents?: number };
}

export function validateAgentDefinition(
  def: AgentDefinitionV1,
  opts: ValidationOptions = {},
): { ok: true } | { ok: false; error: StudioError } {
  const modelRegistry = opts.modelRegistry ?? DEFAULT_MODEL_CAPABILITIES;
  const toolRegistry = opts.toolRegistry ?? DEFAULT_TOOL_DESCRIPTORS;
  const entitlements = opts.entitlements ?? {};

  // 1. Unknown model capability IDs
  const { unknown } = validateAllowedModels(def.model_policy.allowed_models, modelRegistry);
  if (unknown.length > 0) {
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: `unknown model capability: ${unknown.join(', ')}`,
        retryable: 'non-retryable',
        details: { code: 'UNKNOWN_CAPABILITY' as ValidationErrorCode, unknown },
      }),
    };
  }

  // 2. Tools not allowed by org/agent policy — check existence in registry
  for (const tool of def.tools) {
    if (!isKnownTool(tool.name, toolRegistry)) {
      return {
        ok: false,
        error: new StudioError({
          code: 'DEFINITION_INVALID',
          message: `unknown tool: ${tool.name}`,
          retryable: 'non-retryable',
          details: { code: 'UNKNOWN_TOOL' as ValidationErrorCode, tool: tool.name },
        }),
      };
    }
  }

  // 3. Effectful tools without approval/idempotency policy
  for (const tool of def.tools) {
    const desc = getToolDescriptor(tool.name, toolRegistry);
    if (!desc) continue;
    const isEffectful = desc.effectClass === 'MUTATING' || desc.effectClass === 'DESTRUCTIVE';
    if (isEffectful) {
      // Must have approval required either in definition or in descriptor
      const requiresApproval =
        tool.approval === 'required' || desc.approvalRequirement === 'REQUIRED';
      const supportsIdempotency = desc.idempotency === 'supported';
      if (!requiresApproval && !supportsIdempotency) {
        return {
          ok: false,
          error: new StudioError({
            code: 'DEFINITION_INVALID',
            message: `effectful tool ${tool.name} requires approval or idempotency support`,
            retryable: 'non-retryable',
            details: { code: 'EFFECTFUL_WITHOUT_APPROVAL' as ValidationErrorCode, tool: tool.name },
          }),
        };
      }
      // Strict: effectful must have approval=required in definition for Phase 1.
      // Platform built-ins are exempt: they carry platform-owned approval
      // semantics (e.g. request_human_handoff is conversationally approved by
      // design — the approved template plane pins it as optional) and the
      // Engine publish path applies the same bypass (assistants.service.ts
      // built-ins bypass). Existence + the branch above still apply.
      if (
        tool.access === 'write' &&
        tool.approval !== 'required' &&
        desc.effectClass === 'MUTATING' &&
        !PLATFORM_BUILT_IN_TOOLS.has(tool.name)
      ) {
        return {
          ok: false,
          error: new StudioError({
            code: 'DEFINITION_INVALID',
            message: `write tool ${tool.name} must have approval=required`,
            retryable: 'non-retryable',
            details: { code: 'EFFECTFUL_WITHOUT_APPROVAL' as ValidationErrorCode, tool: tool.name },
          }),
        };
      }
    }
  }

  // 4. Limits exceed Engine entitlements — every provided entitlement bound is enforced
  {
    const budget = def.budget_policy as Record<string, unknown>;
    const checks: Array<{ key: string; limit: number | undefined; label: string }> = [
      { key: 'max_model_calls', limit: entitlements.maxModelCalls, label: 'maxModelCalls' },
      { key: 'max_tool_calls', limit: entitlements.maxToolCalls, label: 'maxToolCalls' },
      { key: 'max_cost_cents', limit: entitlements.maxCostCents, label: 'maxCostCents' },
    ];
    for (const c of checks) {
      if (c.limit !== undefined && typeof budget[c.key] === 'number') {
        if ((budget[c.key] as number) > c.limit) {
          return {
            ok: false,
            error: new StudioError({
              code: 'DEFINITION_INVALID',
              message: `budget ${c.key} exceeds entitlement ${c.label}=${c.limit}`,
              retryable: 'non-retryable',
              details: { code: 'LIMITS_EXCEED_ENTITLEMENT' as ValidationErrorCode, key: c.key },
            }),
          };
        }
      }
    }
  }

  // 5. Unsupported context or output modes for selected provider set
  // Example: hybrid_retrieval requires at least one knowledge source if enabled
  if (def.retrieval_policy.hybrid_retrieval && def.context_policy.knowledge_sources.length === 0) {
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: 'hybrid_retrieval requires at least one knowledge_source',
        retryable: 'non-retryable',
        details: { code: 'UNSUPPORTED_CONTEXT' as ValidationErrorCode },
      }),
    };
  }

  // 6. Unbounded recursion, tool counts, model calls, or output sizes
  if (def.budget_policy.max_recursion_depth > 16) {
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: 'max_recursion_depth exceeds maximum 16',
        retryable: 'non-retryable',
        details: { code: 'UNBOUNDED_RECURSION' as ValidationErrorCode },
      }),
    };
  }
  if (def.tools.length > 32) {
    return {
      ok: false,
      error: new StudioError({
        code: 'DEFINITION_INVALID',
        message: 'too many tools: max 32',
        retryable: 'non-retryable',
        details: { code: 'UNBOUNDED_RECURSION' as ValidationErrorCode },
      }),
    };
  }

  // 7. Instructions that attempt to define Engine authority operation
  // Strict: any authority verb/RPC name in instructions is a rejection — instructions are
  // declarative content and must never instruct the runtime to invoke Engine authority.
  const lower = def.instructions.toLowerCase();
  const forbiddenPhrases = [
    'create run',
    'commitrunresult',
    'appendrunevent',
    'neryva.mcp',
    'bypass approval',
    'ignore policy',
    'failrun(',
    'acquireorrenewrunlease',
  ];
  for (const phrase of forbiddenPhrases) {
    if (lower.includes(phrase)) {
      return {
        ok: false,
        error: new StudioError({
          code: 'DEFINITION_INVALID',
          message: `instructions attempt to define Engine authority operation: ${phrase}`,
          retryable: 'non-retryable',
          details: { code: 'INSTRUCTIONS_ENGINE_AUTHORITY' as ValidationErrorCode, phrase },
        }),
      };
    }
  }

  return { ok: true };
}
