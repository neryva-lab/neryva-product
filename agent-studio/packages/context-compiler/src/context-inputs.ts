/**
 * context-inputs.ts — Compiler input model (all Engine-authorized, bounded)
 * Source: agent_studio_architecture.md:448-462, 212-218, 772-790
 * All inputs are references/authorized data, never raw provider-managed state.
 * Final prompt is derived artifact; canonical stays in Engine.
 */

import type { AgentDefinitionV1 } from '@neryva/agent-definition';
import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';

export type { AgentDefinitionV1 };
export type { ToolDescriptor };

export interface ProviderCapabilities {
  supportsStructuredOutput?: boolean | undefined;
  supportsToolCalling?: boolean | undefined;
  supportsStreaming?: boolean | undefined;
  modelId?: string | undefined;
}

export interface PolicySnapshot {
  organizationId: string;
  allowedModels: string[];
  retention?: string | undefined;
  residency?: string | undefined;
  version?: string | undefined;
}

export interface HistoryMessage {
  messageId: string;
  organizationId: string;
  conversationId: string;
  sequence: number; // monotonic, not timestamp — ordering must use sequence (212-218)
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string; // ISO, for display only — not for ordering
  sourceVersion?: string | undefined;
}

export interface Summary {
  summaryId: string;
  organizationId: string;
  conversationId: string;
  // Source range that this summary covers — for citation and version tracking
  sourceRange: { fromSequence: number; toSequence: number };
  version: number;
  content: string;
  createdAt: string;
}

export interface Memory {
  memoryId: string;
  organizationId: string;
  scope: 'user' | 'conversation' | 'organization';
  scopeId: string; // userId or conversationId or organizationId
  content: string;
  sourceMessageId?: string | undefined;
  visibility: 'private' | 'shared' | 'public';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'DELETED' | 'QUARANTINED';
  createdAt: string;
  expiresAt?: string | undefined;
  version: number;
  provenance?: string | undefined;
}

export interface KnowledgeDoc {
  sourceId: string; // document id
  documentVersionId: string;
  chunkId?: string | undefined;
  organizationId: string;
  title?: string | undefined;
  content: string; // bounded, or artifact ref if large
  citation: string;
  status: 'READY' | 'PROCESSING' | 'FAILED' | 'DELETED' | 'QUARANTINED';
  expiresAt?: string | undefined;
  createdAt: string;
  version: number;
  purpose?: string | undefined;
}

export interface CompilerInput {
  // 1 Scope validation
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  /** A4-82: run actor's account id (from the engine manifest). Required to match user-scoped memories. */
  userId?: string | undefined;

  // 2 Immutable definition + policy
  agentDefinition: AgentDefinitionV1;
  policySnapshot: PolicySnapshot;

  // 3 History (Engine-authorized, already tenant-scoped)
  history: HistoryMessage[];
  summaries: Summary[];

  // 4 Memories (Engine-authorized, already filtered)
  memories: Memory[];

  // 5 Knowledge (Engine-authorized, already filtered via WHERE organization_id)
  knowledge: KnowledgeDoc[];

  // 6 Tools (from registry, already authorized)
  availableTools: ToolDescriptor[];

  // 7 Budgets
  maxContextTokens: number; // from agentDefinition.context_policy.max_context_tokens or budget_policy
  maxOutputTokens?: number | undefined;

  // 8 Provider capabilities (for prompt-cache prep, tool support)
  providerCapabilities?: ProviderCapabilities | undefined;

  // 9 Current user message (trigger)
  userMessage: { content: string; sequence: number };

  // 10 Output schema (for structured output)
  outputSchema?: Record<string, unknown> | undefined;
}

export interface CompilerOptions {
  // Token counter override (for tests)
  countTokens?: ((text: string) => number) | undefined;
  // Strict mode: fail-closed on any invariant violation
  strict?: boolean | undefined;
  /**
   * Injectable clock — memory/knowledge expiry checks. The compiler is pure and
   * deterministic for the same input; production activities pass Date.now() here,
   * tests/replay pass a fixed instant. Defaults to wall clock.
   */
  now?: Date | undefined;
}
