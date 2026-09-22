/**
 * compiler.ts — compile immutable definition into execution-ready representation
 * Source: agent_studio_implementation_plan.md:692-724, 703-722
 * Output contains only data needed for the run; no secrets, mutable pointers, or executable code.
 */

import { createHash } from 'node:crypto';
import { StudioError } from '@neryva/agent-kernel';
import type { AgentDefinitionV1 } from './schema.js';
import type { ToolDescriptor } from '../../../contracts/tool/descriptor.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '../../../contracts/tool/descriptor.js';

export const COMPILER_VERSION = '1.0.0';

export interface CompiledToolSchema {
  toolId: string;
  version: string;
  inputSchema: Record<string, unknown>;
  effectClass: string;
  approvalRequirement: string;
}

export interface CompiledDefinition {
  agentVersionId: string;
  definitionSchemaVersion: string;
  instructionsRef: string; // hash of instructions, not raw content for large; but for Phase 1 we store hash
  instructionsHash: string;
  modelPolicy: AgentDefinitionV1['model_policy'];
  contextPolicy: AgentDefinitionV1['context_policy'];
  toolPolicy: { tools: CompiledToolSchema[] };
  guardrailPolicy: AgentDefinitionV1['guardrails'];
  budgetPolicy: NonNullable<AgentDefinitionV1['budget_policy']>;
  retrievalPolicy: NonNullable<AgentDefinitionV1['retrieval_policy']>;
  compiledToolSchemas: CompiledToolSchema[];
  compilerVersion: string;
  policySnapshotRef: string; // hash of policies
  hash: string; // canonical hash of entire compiled definition
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function compileDefinition(
  def: AgentDefinitionV1,
  opts: { agentVersionId: string; policySnapshotRef?: string; toolRegistry?: ToolDescriptor[] } = {
    agentVersionId: `asst_${def.agent_id}_v${def.version}`,
  },
): CompiledDefinition {
  const toolRegistry = opts.toolRegistry ?? DEFAULT_TOOL_DESCRIPTORS;

  const compiledTools: CompiledToolSchema[] = def.tools.map((t) => {
    const desc = toolRegistry.find((d) => d.toolId === t.name);
    if (!desc) {
      // Fail closed: an unknown tool must never compile to a permissive placeholder.
      // Validation should have rejected it, but the compiler must not trust its caller.
      throw new StudioError({
        code: 'DEFINITION_INVALID',
        message: `unknown tool ${t.name} — cannot compile unregistered tool`,
        retryable: 'non-retryable',
        details: { tool: t.name },
      });
    }
    return {
      toolId: desc.toolId,
      version: desc.version,
      inputSchema: desc.inputSchema,
      effectClass: desc.effectClass,
      approvalRequirement: desc.approvalRequirement,
    };
  });

  const instructionsHash = sha256Hex(def.instructions);
  const policySnapshotRef =
    opts.policySnapshotRef ??
    sha256Hex(
      canonicalStringify({
        model: def.model_policy,
        context: def.context_policy,
        tools: def.tools,
        guardrails: def.guardrails,
      }),
    );

  const compiled: Omit<CompiledDefinition, 'hash'> = {
    agentVersionId: opts.agentVersionId,
    definitionSchemaVersion: def.schema_version,
    instructionsRef: `hash:${instructionsHash}`,
    instructionsHash,
    modelPolicy: def.model_policy,
    contextPolicy: def.context_policy,
    toolPolicy: { tools: compiledTools },
    guardrailPolicy: def.guardrails,
    budgetPolicy: def.budget_policy as NonNullable<AgentDefinitionV1['budget_policy']>,
    retrievalPolicy: def.retrieval_policy as NonNullable<AgentDefinitionV1['retrieval_policy']>,
    compiledToolSchemas: compiledTools,
    compilerVersion: COMPILER_VERSION,
    policySnapshotRef,
  };

  const hash = sha256Hex(canonicalStringify(compiled));
  return { ...compiled, hash };
}

export function hashDefinition(def: AgentDefinitionV1): string {
  return sha256Hex(canonicalStringify(def));
}
