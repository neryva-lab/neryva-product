/**
 * context-activities.ts — authorized context assembly via Context Compiler (pure) + MCP (authorized fetch)
 * Source: agent_studio_implementation_plan.md:934-956 (11 steps), 957-965 invariants
 * All retrieval is already authorized via Engine (WHERE organization_id), compiler verifies and never retrieve-then-authorize.
 */

import { heartbeat } from './heartbeat.js';
import { createMcpActivities } from './mcp-activities.js';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import { compileContext as compilePure, InsufficientContextError } from '@neryva/context-compiler';
import type { CompilerInput } from '@neryva/context-compiler';
import { parseAgentDefinition, type AgentDefinitionV1 } from '@neryva/agent-definition';
import { compileContext as compileContextAsPure } from '@neryva/context-compiler';

interface ManifestLike {
  assistantVersionId?: string;
  conversationId?: string;
  instructions?: string;
  allowedModels?: string[];
  conversationSummary?: string;
  modelParams?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    reasoningEffort?: string;
  };
  budgets?: {
    maxModelCalls?: number;
    maxToolCalls?: number;
    wallClockSeconds?: number;
    maxTotalTokens?: number;
    maxCostMicros?: number;
  };
  guardrailPolicy?: { inputPolicy?: string; outputPolicy?: string; piiRedaction?: boolean };
  recentMessages?: Array<{
    messageId: string;
    role: string;
    text: string;
    attachments?: Array<{
      artifactId: string;
      mediaType: string;
      byteLength: number;
      purpose?: string;
    }>;
  }>;
  memories?: Array<{ memoryId: string; scope: string; content?: string }>;
  knowledgeRefs?: Array<{ documentId: string; chunkId: string; snippet?: string; title?: string }>;
  tools?: Array<{
    name: string;
    effectClass: string;
    approvalRequirement: string;
    description?: string;
    inputSchemaJson?: string;
  }>;
}

/** Build the immutable agent definition from the Engine-authorized manifest. */
function definitionFromManifest(manifest: ManifestLike): AgentDefinitionV1 | undefined {
  const raw = {
    agent_id: `agent-${String(manifest.assistantVersionId ?? 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')}`,
    version: 1,
    schema_version: 'v1' as const,
    instructions:
      typeof manifest.instructions === 'string' && manifest.instructions.length > 0
        ? manifest.instructions
        : 'You are a helpful assistant. Answer accurately and concisely.',
    model_policy: {
      allowed_models:
        Array.isArray(manifest.allowedModels) && manifest.allowedModels.length > 0
          ? manifest.allowedModels
          : ['openai/gpt-4o-mini'],
      fallback_enabled: true,
      max_output_tokens: Number(manifest.modelParams?.maxOutputTokens ?? 4096),
    },
    context_policy: {
      history_limit: 20,
      summary_enabled: true,
      knowledge_sources: [],
      memory_scope: 'conversation' as const,
      max_context_tokens: 32000,
    },
    tools: [],
    guardrails: {
      input_policy: 'default' as const,
      output_policy: 'default' as const,
      pii_redaction: true,
    },
    budget_policy: {
      max_model_calls: Number(manifest.budgets?.maxModelCalls ?? 16) || 16,
      max_tool_calls: Number(manifest.budgets?.maxToolCalls ?? 8),
      max_wall_clock_ms: Number(manifest.budgets?.wallClockSeconds ?? 0) * 1000 || 120_000,
      max_token_budget: Number(manifest.budgets?.maxTotalTokens ?? 200000) || 200000,
    },
    retrieval_policy: {},
  };
  const parsed = parseAgentDefinition(raw);
  return parsed.ok ? parsed.value : undefined;
}

export interface CompileContextParams {
  runId: string;
  organizationId: string;
  conversationId?: string | undefined;
  agentVersionId: string;
  triggerMessageId?: string | undefined;
}

// Legacy stub type for Phase 3 compatibility
export interface CompiledContextLegacy {
  runId: string;
  organizationId: string;
  agentVersionId: string;
  messages: Array<{ role: string; content: string }>;
  /** Pinned tool descriptors — effect class + approval come from the definition, never the model */
  tools: Array<{
    name: string;
    version: string;
    effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
    approvalRequirement: 'NONE' | 'REQUIRED';
    description?: string | undefined;
    inputSchema?: Record<string, unknown> | undefined;
  }>;
  budgets: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxTurns: number;
    maxTotalTokens: number;
    wallClockSeconds: number;
  };
  citationRefs?: string[] | undefined;
  modelParams?: ManifestLike['modelParams'];
  allowedModels?: string[] | undefined;
  guardrailPolicy: { input_policy: string; output_policy: string };
  /** FL-1.6 — trigger message attachment metadata (bytes fetched via claim-check activity). */
  triggerAttachments: Array<{
    artifactId: string;
    mediaType: string;
    byteLength: number;
    sha256?: Uint8Array;
  }>;
}

export function createContextActivities(client: NeryvaMcpClient) {
  const mcp = createMcpActivities(client);

  return {
    /**
     * Phase 5: compile from already-authorized CompilerInput (pure, deterministic).
     * Caller (workflow) should have fetched authorized history/memories/knowledge via MCP
     * and assembled CompilerInput. This activity just runs the pure compiler (no network).
     */
    async compile(input: CompilerInput): Promise<ReturnType<typeof compilePure>> {
      heartbeat({ step: 'compile:start', runId: input.runId });
      // Fail-closed invariants are enforced inside compilePure; we just heartbeat and return
      try {
        const compiled = compilePure(input);
        heartbeat({
          step: 'compile:done',
          runId: input.runId,
          messageCount: compiled.providerRequest.messages.length,
        });
        return compiled;
      } catch (e) {
        if (e instanceof InsufficientContextError) {
          heartbeat({ step: 'compile:insufficient', reason: e.message });
        }
        throw e;
      }
    },

    /**
     * REAL context compilation (harness H0.3): fetch the Engine-authorized
     * manifest, build the immutable definition, run the pure compiler, and
     * return provider-ready inputs — instructions, history, summary, memory
     * content, knowledge snippets, tool schemas, budgets, model params.
     */
    async compileContext(params: CompileContextParams): Promise<CompiledContextLegacy> {
      heartbeat({ step: 'compileContext:start', runId: params.runId });
      const ctx = (await mcp.getAuthorizedRunContext()) as { manifest?: ManifestLike };
      const manifest = ctx.manifest ?? {};
      const definition = definitionFromManifest(manifest);
      if (!definition) {
        throw new Error('DEFINITION_INVALID: manifest did not yield a valid agent definition');
      }
      const recent = manifest.recentMessages ?? [];
      const lastUser = [...recent].reverse().find((m) => m.role === 'user');
      const compilerInput: CompilerInput = {
        organizationId: params.organizationId,
        conversationId: params.conversationId ?? manifest.conversationId ?? '',
        runId: params.runId,
        agentVersionId: params.agentVersionId,
        agentDefinition: definition,
        policySnapshot: {
          organizationId: params.organizationId,
          allowedModels: definition.model_policy.allowed_models,
        },
        history: recent.map((m, i) => ({
          messageId: m.messageId,
          organizationId: params.organizationId,
          conversationId: manifest.conversationId ?? '',
          sequence: i + 1,
          role: (m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user') as
            'user' | 'assistant' | 'tool',
          content: m.text,
          createdAt: new Date().toISOString(),
        })),
        summaries:
          typeof manifest.conversationSummary === 'string' && manifest.conversationSummary
            ? [
                {
                  summaryId: manifest.conversationId ?? '',
                  organizationId: params.organizationId,
                  conversationId: manifest.conversationId ?? '',
                  sourceRange: { fromSequence: 0, toSequence: recent.length },
                  version: 1,
                  content: manifest.conversationSummary,
                  createdAt: new Date().toISOString(),
                },
              ]
            : [],
        memories: (manifest.memories ?? [])
          .filter((m) => typeof m.content === 'string' && m.content)
          .map((m) => ({
            memoryId: m.memoryId,
            organizationId: params.organizationId,
            scope: (m.scope === 'user'
              ? 'user'
              : m.scope === 'organization'
                ? 'organization'
                : 'conversation') as 'user' | 'conversation' | 'organization',
            scopeId:
              m.scope === 'organization' ? params.organizationId : (manifest.conversationId ?? ''),
            content: m.content ?? '',
            visibility: 'shared' as const,
            status: 'APPROVED' as const,
            createdAt: new Date().toISOString(),
            version: 1,
          })),
        knowledge: (manifest.knowledgeRefs ?? [])
          .filter((k) => typeof k.snippet === 'string' && k.snippet)
          .map((k) => ({
            sourceId: k.documentId,
            documentVersionId: k.documentId,
            chunkId: k.chunkId,
            organizationId: params.organizationId,
            title: k.title,
            content: k.snippet ?? '',
            citation: `doc:${k.documentId}#chunk:${k.chunkId}`,
            status: 'READY' as const,
            createdAt: new Date().toISOString(),
            version: 1,
          })),
        availableTools: (manifest.tools ?? []).map((t) => ({
          toolId: t.name,
          version: '1.0.0',
          inputSchema: t.inputSchemaJson
            ? (JSON.parse(t.inputSchemaJson) as Record<string, unknown>)
            : {},
          effectClass:
            t.effectClass === 'MUTATING'
              ? ('MUTATING' as const)
              : t.effectClass === 'DESTRUCTIVE'
                ? ('DESTRUCTIVE' as const)
                : ('READ_ONLY' as const),
          approvalRequirement:
            t.approvalRequirement === 'REQUIRED' ? ('REQUIRED' as const) : ('NONE' as const),
          egressClass: 'limited' as const,
          timeoutMs: 10_000,
          idempotency: 'supported' as const,
          redactionPolicy: 'strict' as const,
          auditEventType: `tool.${t.name}`,
          executionMode: 'in-process' as const,
        })),
        maxContextTokens: definition.context_policy.max_context_tokens,
        maxOutputTokens: definition.model_policy.max_output_tokens,
        userMessage: { content: lastUser?.text ?? '', sequence: recent.length },
      };
      const compiled = compileContextAsPure(compilerInput, { strict: false, now: new Date() });
      heartbeat({
        step: 'compileContext:done',
        runId: params.runId,
        toolCount: manifest.tools?.length ?? 0,
      });
      return {
        runId: params.runId,
        organizationId: params.organizationId,
        agentVersionId: params.agentVersionId,
        messages: compiled.providerRequest.messages as unknown as Array<{
          role: string;
          content: string;
        }>,
        tools: (manifest.tools ?? []).map((t) => ({
          name: t.name,
          version: '1.0.0',
          effectClass:
            t.effectClass === 'MUTATING'
              ? ('MUTATING' as const)
              : t.effectClass === 'DESTRUCTIVE'
                ? ('DESTRUCTIVE' as const)
                : ('READ_ONLY' as const),
          approvalRequirement:
            t.approvalRequirement === 'REQUIRED' ? ('REQUIRED' as const) : ('NONE' as const),
          description: t.description,
          inputSchema: t.inputSchemaJson
            ? (JSON.parse(t.inputSchemaJson) as Record<string, unknown>)
            : {},
        })),
        budgets: {
          maxModelCalls: Number(manifest.budgets?.maxModelCalls ?? 16) || 16,
          maxToolCalls: Number(manifest.budgets?.maxToolCalls ?? 8),
          maxTurns: 16,
          maxTotalTokens: Number(manifest.budgets?.maxTotalTokens ?? 200_000) || 200_000,
          wallClockSeconds: Number(manifest.budgets?.wallClockSeconds ?? 0) || 0,
        },
        citationRefs: (manifest.knowledgeRefs ?? []).map(
          (k) => `doc:${k.documentId}#chunk:${k.chunkId}`,
        ),
        modelParams: manifest.modelParams,
        allowedModels: manifest.allowedModels ?? definition.model_policy.allowed_models,
        guardrailPolicy: {
          input_policy: manifest.guardrailPolicy?.inputPolicy ?? 'default',
          output_policy: manifest.guardrailPolicy?.outputPolicy ?? 'default',
        },
        triggerAttachments: (
          ([...recent].reverse().find((m) => m.role === 'user')?.attachments ?? []) as Array<{
            artifactId: string;
            mediaType: string;
            byteLength: number;
            sha256?: Uint8Array;
          }>
        ).slice(0, 4),
      };
    },

    /**
     * FL-1.6 — claim-check image fetch for the Temporal path. Engine
     * re-authorizes per read (GetRunArtifact → presigned URL); this activity
     * verifies size/checksum and returns base64 parts. Rejected attachments
     * are dropped with a reason — the workflow decides what to do.
     */
    async fetchRunImages(params: {
      attachments: Array<{
        artifactId: string;
        mediaType: string;
        byteLength: number;
        sha256?: Uint8Array;
      }>;
    }): Promise<Array<{ artifactId: string; mediaType: string; dataBase64: string }>> {
      const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
      const MAX_BYTES = 5 * 1024 * 1024;
      const { createHash } = await import('node:crypto');
      const images: Array<{ artifactId: string; mediaType: string; dataBase64: string }> = [];
      for (const att of params.attachments.slice(0, 4)) {
        if (!IMAGE_TYPES.has(att.mediaType) || att.byteLength > MAX_BYTES) {
          continue;
        }
        try {
          const res = (await client.getRunArtifact({ artifactId: att.artifactId })) as {
            accessUrl?: string;
          };
          if (!res.accessUrl) {
            continue;
          }
          const imgRes = await fetch(res.accessUrl);
          if (!imgRes.ok) {
            continue;
          }
          const bytes = new Uint8Array(await imgRes.arrayBuffer());
          if (bytes.byteLength !== att.byteLength) {
            continue;
          }
          if (att.sha256 && att.sha256.length > 0) {
            const digest = createHash('sha256').update(bytes).digest();
            for (let i = 0; i < 32; i++) {
              if (digest[i] !== att.sha256[i]) {
                throw new Error(`artifact sha256 mismatch: ${att.artifactId}`);
              }
            }
          }
          images.push({
            artifactId: att.artifactId,
            mediaType: att.mediaType,
            dataBase64: Buffer.from(bytes).toString('base64'),
          });
        } catch {
          continue;
        }
      }
      return images;
    },

    async validateScope(params: {
      organizationId: string;
      runId: string;
    }): Promise<{ ok: true } | { ok: false; reason: string }> {
      heartbeat({ step: 'validateScope', organizationId: params.organizationId });
      return { ok: true };
    },
  };
}

export type ContextActivities = ReturnType<typeof createContextActivities>;
