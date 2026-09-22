/**
 * inline-executor.ts — direct, in-process AgentRun execution.
 *
 * This is the harness run loop for deployments without a Temporal server
 * (EXECUTION_MODE=inline) and the reference semantics for the Temporal
 * workflow: Engine-owned scope, MCP-authority calls only, bounded loop,
 * coalesced AssistantChunk streaming, usage delivered on the terminal commit.
 *
 * Durability contract: Engine is the system of record — lease fencing +
 * idempotent AppendRunEvents/CommitRunResult make a crashed executor safe to
 * re-drive (the accepted-run sweep re-dispatches; the Engine dedups).
 *
 * Loop correctness (FL-1.1..FL-1.3):
 * - EVERY tool call the model proposes in a turn executes — READ_ONLY calls
 *   concurrently, MUTATING/DESTRUCTIVE serialized in proposal order, through
 *   the Tool Gateway policy boundary; results join into ONE bounded tool
 *   message that feeds the next model turn.
 * - RunBudgets (max_total_tokens, max_cost_micros, wall_clock_seconds) are
 *   enforced inside the loop; breach → RunWarning + FailRun(BUDGET_EXHAUSTED).
 * - A run-scoped AbortController is wired into every provider call; Engine
 *   cancellation (or the wall-clock deadline) aborts the in-flight stream.
 */

import { createConnectTransport } from '@connectrpc/connect-node';
import { createHash } from 'node:crypto';
import type { Transport } from '@connectrpc/connect';
import { NeryvaMcpClient, type CapabilityToken } from '@neryva/neryva-mcp-client';
import { createRuntimeEvent, type RuntimeEvent } from '@neryva/contracts/events/runtime-events';
import { startSpan, endSpan, type CorrelationContext } from '@neryva/telemetry';
import { parseAgentDefinition, type AgentDefinitionV1 } from '@neryva/agent-definition';
import {
  compileContext,
  toImagePartsMessage,
  IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  type CompilerInput,
} from '@neryva/context-compiler';
import { ModelGateway } from '@neryva/model-gateway';
import type { NeryvaMessage } from '@neryva/contracts/provider/model-request';
import {
  moderateContent,
  resolveGuardrailPolicy,
  noopModerationHook,
  type ModerationHook,
} from '@neryva/security';
import { ToolGateway, InMemoryToolRegistry, type ToolContext } from '@neryva/tool-gateway';
import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import { create } from '@bufbuild/protobuf';
import {
  ArtifactRefSchema,
  type ArtifactRef,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js';
import type { Config } from './config.js';
import type { RunCancellationRegistry } from './run-registry.js';

export interface InlineRunInput {
  runId: string;
  organizationId: string;
  conversationId: string;
  agentVersionId: string;
  actorId: string;
  capabilityId: string;
  capabilityToken: string;
}

/** Executor bound per tool name — real executors land via FL-2.10/FL-2.11. */
export type ToolExecutorFn = (args: unknown, ctx: ToolContext) => Promise<unknown>;

export interface InlineExecutorDeps {
  config: Config;
  transport?: Transport | undefined;
  gateway?: ModelGateway | undefined;
  /** Engine cancellation → aborts the in-flight provider call (FL-1.3). */
  cancellations?: RunCancellationRegistry | undefined;
  /** Bound tool executors keyed by tool name; unbound tools fail closed. */
  toolHandlers?: ReadonlyMap<string, ToolExecutorFn> | undefined;
  /** Runtime moderation hook (FL-1.4); noop default keeps dev frictionless. */
  moderation?: ModerationHook | undefined;
}

/** Coalescing buffer: emit a chunk at ≥ N chars or every M ms, whichever first. */
const CHUNK_CHARS = 220;
const CHUNK_MS = 400;
const MAX_TURNS = 16;
const SUMMARY_SOURCE_THRESHOLD = 12;
/** One tool message per turn — bounded (claim-check policy for large results). */
const TOOL_MESSAGE_MAX_CHARS = 24_000;
/** Per-result bound inside the joined tool message. */
const TOOL_RESULT_MAX_CHARS = 6_000;

function buildCapability(input: InlineRunInput, config: Config): CapabilityToken {
  // Prefer the Engine-issued JWT: decode its payload for the real capabilityId/
  // allowed_ops so the RequestContext.capabilityId matches the presented token
  // (engine's routes.ts enforces this binding). Fallback keeps dev/test without
  // a real token functional (expiry advisory — Engine re-validates).
  if (input.capabilityToken) {
    try {
      const payloadB64 = input.capabilityToken.split('.')[1] ?? '';
      const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const claims = JSON.parse(json) as {
        capability_id?: string;
        allowed_ops?: string[];
        exp?: number;
        iat?: number;
        kid?: string;
      };
      if (claims.capability_id) {
        return {
          capabilityId: claims.capability_id,
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          runId: input.runId,
          agentVersionId: input.agentVersionId,
          actorId: input.actorId,
          allowedMethods:
            Array.isArray(claims.allowed_ops) && claims.allowed_ops.length > 0
              ? claims.allowed_ops
              : ['*'],
          issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : Date.now(),
          expiresAt:
            typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 24 * 3600 * 1000,
          keyId: claims.kid ?? config.mcpEndpoint,
        };
      }
    } catch {
      // Intentional: best-effort JWT decode only — a malformed token falls
      // through to the safe default capability below (the Engine re-validates
      // the token on every authority RPC, so this never grants anything).
    }
  }
  return {
    capabilityId: input.capabilityId,
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    runId: input.runId,
    agentVersionId: input.agentVersionId,
    actorId: input.actorId,
    allowedMethods: ['*'],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    keyId: config.mcpEndpoint,
  };
}

function transportFor(
  config: Config,
  override?: Transport | undefined,
  capabilityToken?: string,
): Transport {
  if (override) return override;
  const base = createConnectTransport({ baseUrl: config.mcpEndpoint, httpVersion: '1.1' });
  if (!capabilityToken) return base;
  // Engine authority expects the JWT in Authorization: Bearer <token> (routes.ts:115).
  // Wrap the transport so every RPC carries it without touching per-call headers.
  // createConnectTransport returns a Transport with an interceptor chain; we
  // re-wrap it with our auth interceptor by creating a new transport that
  // delegates with the header set. Simplest: use the transport's internal
  // fetch to inject header via a delegating transport object.
  return {
    ...base,
    unary: async (service, method, signal, header, message, contextValues) => {
      const h = new Headers(header as Headers);
      h.set('authorization', `Bearer ${capabilityToken}`);
      return (
        base.unary as unknown as (
          s: unknown,
          m: unknown,
          sig: unknown,
          h: unknown,
          msg: unknown,
          cv: unknown,
        ) => Promise<unknown>
      )(service, method, signal, h, message, contextValues);
    },
    stream: async (service, method, signal, header, message, contextValues) => {
      const h = new Headers(header as Headers);
      h.set('authorization', `Bearer ${capabilityToken}`);
      return (
        base.stream as unknown as (
          s: unknown,
          m: unknown,
          sig: unknown,
          h: unknown,
          msg: unknown,
          cv: unknown,
        ) => Promise<unknown>
      )(service, method, signal, h, message, contextValues);
    },
  } as Transport;
}

interface ManifestLike {
  assistantVersionId?: string;
  instructions?: string;
  allowedModels?: string[];
  conversationSummary?: string;
  modelParams?: { maxOutputTokens?: number; outputSchema?: string; followup_suggestions?: boolean };
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
      sha256?: Uint8Array;
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
    httpBinding?: { url: string; method: string; timeout_ms: number; header_name: string } | null;
  }>;
}

function producer(input: InlineRunInput) {
  return {
    runId: input.runId,
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    producerId: 'runtime-control:inline',
    correlationId: input.runId,
  };
}

function event(
  input: InlineRunInput,
  type: RuntimeEvent['type'],
  body: RuntimeEvent['body'],
): RuntimeEvent {
  return createRuntimeEvent({ ...producer(input), type }, body);
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

/** sha256 over the canonical JSON of the tool args — the Engine dedup digest. */
function argsDigest(args: unknown): Uint8Array {
  return createHash('sha256')
    .update(JSON.stringify(args ?? {}))
    .digest();
}

/** sha256 over the result body — RecordToolOutcome dedup digest. */
function resultDigest(result: unknown): Uint8Array {
  return createHash('sha256')
    .update(JSON.stringify(result ?? null))
    .digest();
}

interface ToolTurnEntry {
  tool_call_id: string;
  tool: string;
  status: 'EXECUTED' | 'FAILED' | 'DENIED' | 'NOT_ALLOWLISTED';
  result: unknown;
}

function boundEntry(entry: ToolTurnEntry): ToolTurnEntry {
  const text = JSON.stringify(entry.result ?? null);
  if (text.length <= TOOL_RESULT_MAX_CHARS) return entry;
  return {
    ...entry,
    result: {
      truncated: true,
      original_chars: text.length,
      preview: text.slice(0, TOOL_RESULT_MAX_CHARS),
    },
  };
}

export function createInlineExecutor(deps: InlineExecutorDeps) {
  const { config } = deps;
  const gateway =
    deps.gateway ??
    new ModelGateway({
      // LiteLLM (ADR-009) is the provider-neutral default: one OpenAI-
      // compatible endpoint fronts 100+ providers. When constructed without a
      // gateway here, callers inject one configured with the LiteLLM adapter
      // (baseUrl + virtual key); simulation adapters serve dev/test only.
      allowTestCredentials: config.environment !== 'production',
    });
  // Cost budget: Studio approximates max_cost_micros with a configured
  // micros-per-1k-tokens rate (0 = unmanaged Studio-side; the Engine's usage
  // ledger + quota reservations remain the billing authority).
  const costMicrosPer1kTokens = config.costMicrosPer1kTokens;

  return async function executeRun(input: InlineRunInput): Promise<{ resultText: string }> {
    const client = new NeryvaMcpClient({
      transport: transportFor(config, deps.transport, input.capabilityToken),
      capability: buildCapability(input, config),
      grantedScope: {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        runId: input.runId,
        agentVersionId: input.agentVersionId,
        actorId: input.actorId,
      },
      protocolVersion: '1.0',
    });

    // Run-scoped cancellation (FL-1.3): a COMBINED controller is wired into
    // every provider call — Engine CancelRun aborts it via the registry
    // signal, and the wall-clock deadline aborts it from the timer. Local
    // fallback keeps the executor correct standalone (no registry dep).
    const cancellation = deps.cancellations?.register(input.runId) ?? {
      signal: new AbortController().signal,
      done: () => {},
    };
    const controller = new AbortController();
    const forwardCancel = (): void => {
      controller.abort(deps.cancellations?.reason(input.runId) || 'cancel');
    };
    if (cancellation.signal.aborted) {
      forwardCancel();
    } else {
      cancellation.signal.addEventListener('abort', forwardCancel, { once: true });
    }
    try {
      return await runLoop(client, controller, input);
    } finally {
      cancellation.signal.removeEventListener('abort', forwardCancel);
      cancellation.done();
    }
  };

  async function runLoop(
    client: NeryvaMcpClient,
    controller: AbortController,
    input: InlineRunInput,
  ): Promise<{ resultText: string }> {
    // 1. Claim (lease fencing) — Engine CAS on lease_epoch.
    const claim = (await client.claimRun({})) as {
      run?: { leaseEpoch?: bigint; version?: bigint };
      acquired?: boolean;
      leaseEpoch?: bigint;
    };
    if (claim.acquired === false) {
      throw new Error(`RUN_ALREADY_CLAIMED:${input.runId}`);
    }
    const leaseEpoch: bigint = claim.run?.leaseEpoch ?? claim.leaseEpoch ?? 0n;
    const expectedRunVersion: bigint = claim.run?.version ?? 0n;

    const startedAtMs = Date.now();

    // Budget state (FL-1.2) — resolved from the manifest budgets once the
    // context arrives; wall-clock deadline also arms an aborting timer so a
    // mid-stream breach interrupts the provider call itself.
    let maxTotalTokens = 200_000;
    let maxCostMicros = 0;
    let maxToolCalls = 8;
    let wallClockDeadlineMs = startedAtMs + 120_000;

    // The abort REASON travels on the controller signal: 'budget_wall_clock'
    // from the deadline timer, the Engine cancel reason from the registry
    // forward. Reading both through functions defeats TS's unsound narrowing
    // of closure-mutated locals and readonly properties (signal.aborted).
    const abortReason = (): string | undefined => {
      const r: unknown = controller.signal.reason;
      return typeof r === 'string' && r.length > 0 ? r : undefined;
    };
    const isBudgetAbort = (): boolean => abortReason() === 'budget_wall_clock';
    const isAborted = (): boolean => abortReason() !== undefined;

    const armDeadlineTimer = (): void => {
      const remaining = wallClockDeadlineMs - Date.now();
      if (remaining <= 0) {
        controller.abort('budget_wall_clock');
        return;
      }
      const timer = setTimeout(() => controller.abort('budget_wall_clock'), remaining);
      timer.unref();
    };

    // 2. Authorized context — the Engine assembles; Studio never widens scope.
    const ctxRes = (await client.getAuthorizedRunContext([])) as { manifest?: ManifestLike };
    const manifest = ctxRes.manifest ?? {};
    const definition = definitionFromManifest(manifest);
    if (!definition) {
      throw new Error('DEFINITION_INVALID: manifest did not yield a valid agent definition');
    }
    const budgets = manifest.budgets ?? {};
    maxTotalTokens = Number(budgets.maxTotalTokens ?? 200_000) || 200_000;
    maxCostMicros = Number(budgets.maxCostMicros ?? 0) || 0;
    maxToolCalls = Number(budgets.maxToolCalls ?? definition.budget_policy.max_tool_calls) || 8;
    const wallClockSeconds = Number(budgets.wallClockSeconds ?? 0);
    wallClockDeadlineMs =
      wallClockSeconds > 0
        ? startedAtMs + wallClockSeconds * 1000
        : startedAtMs + definition.budget_policy.max_wall_clock_ms;
    armDeadlineTimer();

    let terminal:
      'COMPLETED' | 'FAILED_BUDGET' | 'FAILED_GUARDRAIL' | 'CANCELLED' | 'PARKED_APPROVAL' =
      'COMPLETED';

    // FL-1.4 — user input screening at run start. A block fails the run
    // GUARDRAIL_BLOCKED before any model call or tool effect.
    const guardrailPolicy = resolveGuardrailPolicy({
      input_policy: manifest.guardrailPolicy?.inputPolicy,
      output_policy: manifest.guardrailPolicy?.outputPolicy,
    });
    const moderationHook = deps.moderation ?? noopModerationHook;
    const screeningUser = [...(manifest.recentMessages ?? [])]
      .reverse()
      .find((m) => m.role === 'user');
    if (screeningUser && screeningUser.text) {
      const inputBlocked = await moderateContent(
        moderationHook,
        guardrailPolicy,
        screeningUser.text,
        'input',
      );
      if (inputBlocked) {
        terminal = 'FAILED_GUARDRAIL';
        await failGuardrailBlocked('input', inputBlocked.categories);
        try {
          await client.releaseRunLease(leaseEpoch);
        } catch {
          // Lease expiry is the safety net.
        }
        return { resultText: '' };
      }
    }

    // 3. Compile — pure token budgeting + ordering + cache-friendly layout.
    const recent = manifest.recentMessages ?? [];
    const lastUser = [...recent].reverse().find((m) => m.role === 'user');
    const compilerInput: CompilerInput = {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      runId: input.runId,
      agentVersionId: input.agentVersionId,
      agentDefinition: definition,
      policySnapshot: {
        organizationId: input.organizationId,
        allowedModels: definition.model_policy.allowed_models,
      },
      history: recent.map((m, i) => ({
        messageId: m.messageId,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
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
                summaryId: `${input.conversationId}:manifest`,
                organizationId: input.organizationId,
                conversationId: input.conversationId,
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
          organizationId: input.organizationId,
          scope: (m.scope === 'user'
            ? 'user'
            : m.scope === 'organization'
              ? 'organization'
              : 'conversation') as 'user' | 'conversation' | 'organization',
          scopeId: m.scope === 'organization' ? input.organizationId : input.conversationId,
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
          organizationId: input.organizationId,
          title: k.title,
          content: k.snippet ?? '',
          citation: `doc:${k.documentId}#chunk:${k.chunkId}`,
          status: 'READY' as const,
          createdAt: new Date().toISOString(),
          version: 1,
        })),
      // Tools with Engine-pinned JSON Schemas — the model can emit valid calls.
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
      // FL-2.14 — structured output end-to-end.
      outputSchema: manifest.modelParams?.outputSchema
        ? (JSON.parse(manifest.modelParams.outputSchema) as Record<string, unknown>)
        : undefined,
      userMessage: {
        content: lastUser?.text ?? '',
        sequence: recent.length,
      },
    };
    const compiled = compileContext(compilerInput, { strict: false, now: new Date() });

    await client.appendRunEvents([
      event(input, 'ContextPrepared', {
        kind: 'ContextPrepared',
        runId: input.runId,
        citationCount: (manifest.knowledgeRefs ?? []).length,
      }),
    ]);

    // 4. Tool execution surface (FL-1.1) — the pinned descriptor set IS the
    // registry (an unlisted tool cannot execute; the model cannot widen it).
    const descriptors: ToolDescriptor[] = compilerInput.availableTools.map((t) => ({
      toolId: t.toolId,
      version: t.version,
      inputSchema: t.inputSchema,
      effectClass: t.effectClass,
      approvalRequirement: t.approvalRequirement,
      egressClass: t.egressClass,
      timeoutMs: t.timeoutMs,
      idempotency: t.idempotency,
      redactionPolicy: t.redactionPolicy,
      auditEventType: t.auditEventType,
      executionMode: t.executionMode,
    }));
    // Built-in executors — tools whose execution IS an Engine RPC (FL-1.7c).
    // Merge AFTER injected handlers so a deployment can override.
    const builtins = new Map<string, ToolExecutorFn>([
      [
        'web_search',
        async (args) => {
          // FL-3.5 - hosted web search via the builtin endpoint. Unconfigured
          // deployments fail closed (TOOL_EXECUTOR_UNBOUND semantics).
          const url = config.guardrails.webSearchUrl;
          if (!url) {
            throw new Error('WEB_SEARCH_UNCONFIGURED: HARNESS__WEB_SEARCH_URL is not set');
          }
          const query = String((args as { query?: unknown }).query ?? '').slice(0, 512);
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            return { error: `web_search HTTP ${res.status}` };
          }
          return await res.json();
        },
      ],
      [
        'request_human_handoff',
        async (args) => {
          const reasonArg = (args as { reason?: unknown }).reason;
          const reason =
            typeof reasonArg === 'string' && reasonArg.trim()
              ? reasonArg
              : 'tool:request_human_handoff';
          const res = (await client.requestHumanHandoff({ reason })) as {
            escalation_id?: string;
            state?: string;
          };
          return {
            escalated: true,
            escalation_id: res.escalation_id ?? '',
            state: res.state ?? '',
          };
        },
      ],
      [
        'generate_image',
        async (args) => {
          // FL-3.2 - image generation builtin: hosted endpoint → bounded
          // GENERATED_MEDIA artifact via claim-check (PutRunArtifact) →
          // `media.generated` run event (Engine pins the ref on the reply;
          // the channel plane delivers it through the media senders).
          const url = config.guardrails.imageGenUrl;
          if (!url) {
            throw new Error('IMAGE_GEN_UNCONFIGURED: HARNESS__IMAGE_GEN_URL is not set');
          }
          const prompt = String((args as { prompt?: unknown }).prompt ?? '').slice(0, 1000);
          if (!prompt.trim()) {
            throw new Error('generate_image requires a non-empty prompt');
          }
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) {
            return { error: `generate_image HTTP ${res.status}` };
          }
          const body = (await res.json()) as { image_base64?: unknown; media_type?: unknown };
          if (typeof body.image_base64 !== 'string' || body.image_base64.length === 0) {
            return { error: 'generate_image payload malformed' };
          }
          const mediaType = typeof body.media_type === 'string' ? body.media_type : 'image/png';
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) {
            return { error: `generate_image unsupported media ${mediaType}` };
          }
          const bytes = Buffer.from(body.image_base64, 'base64');
          if (bytes.byteLength > 5 * 1024 * 1024) {
            return { error: 'generate_image output exceeds the 5 MiB attachment cap' };
          }
          const artifact = (await client.putRunArtifact({
            purpose: 'GENERATED_MEDIA',
            mediaType,
            data: bytes,
          })) as {
            artifact_id?: string;
            byte_length?: number;
          };
          const artifactId = String(artifact.artifact_id ?? '');
          if (!artifactId) {
            throw new Error('generate_image: PutRunArtifact returned no artifact id');
          }
          await client.appendRunEvents([
            event(input, 'MediaGenerated', {
              kind: 'MediaGenerated',
              runId: input.runId,
              artifactId,
              mediaType,
            }),
          ]);
          return {
            generated: true,
            artifact_id: artifactId,
            media_type: mediaType,
            byte_length: artifact.byte_length ?? bytes.byteLength,
          };
        },
      ],
    ]);
    // FL-2.10 - HTTP tool executor binding: catalog-declared customer
    // endpoints. The credential is disclosed per-run via the Engine's scoped
    // GetToolCredential op (never in the manifest); timeout + rate limits
    // come from the binding and the pinned tool policy.
    const httpBindings = new Map<
      string,
      { url: string; method: string; timeoutMs: number; headerName: string }
    >();
    for (const t of manifest.tools ?? []) {
      if (t.httpBinding && typeof t.httpBinding.url === 'string' && t.httpBinding.url) {
        httpBindings.set(t.name, {
          url: t.httpBinding.url,
          method: t.httpBinding.method || 'POST',
          timeoutMs: t.httpBinding.timeout_ms || 10_000,
          headerName: t.httpBinding.header_name || 'authorization',
        });
      }
    }
    for (const [name, binding] of httpBindings) {
      if (!builtins.has(name)) {
        builtins.set(name, async (args) => {
          const cred = (await client.getToolCredential({ toolName: name })) as {
            credential: string;
            credentialHeader: string;
          };
          const res = await fetch(binding.url, {
            method: binding.method,
            headers: {
              'content-type': 'application/json',
              ...(cred.credential ? { [cred.credentialHeader]: `Bearer ${cred.credential}` } : {}),
            },
            body: JSON.stringify(args ?? {}),
            signal: AbortSignal.timeout(binding.timeoutMs),
          });
          const text = await res.text();
          return { status: res.status, body: text.slice(0, 20_000) };
        });
      }
    }

    const boundHandlers: ReadonlyMap<string, ToolExecutorFn> = deps.toolHandlers
      ? new Map<string, ToolExecutorFn>([...deps.toolHandlers, ...builtins])
      : builtins;
    const toolGateway = new ToolGateway(new InMemoryToolRegistry(descriptors));
    const toolContext: ToolContext = {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      runId: input.runId,
      agentVersionId: input.agentVersionId,
      policyVersion: String(manifest.assistantVersionId ?? 'manifest'),
      correlationId: input.runId,
      actorId: input.actorId,
      budget: { maxToolCalls },
    };
    // Manifest-authored descriptions (pinned catalog) — surfaced to the model.
    const manifestDescriptions = new Map<string, string>();
    for (const t of manifest.tools ?? []) {
      if (typeof t.description === 'string' && t.description) {
        manifestDescriptions.set(t.name, t.description);
      }
    }
    const tools: Array<{ name: string; description: string; schema: unknown }> =
      compilerInput.availableTools.map((t) => ({
        name: t.toolId,
        description: manifestDescriptions.get(t.toolId) ?? t.toolId,
        schema: t.inputSchema,
      }));
    const toolPolicies = new Map(compilerInput.availableTools.map((t) => [t.toolId, t]));

    // Provider conversation — tool results feed the next turn (FL-1.1).
    const messages: NeryvaMessage[] = [...compiled.providerRequest.messages];

    // FL-2.16 - tool-result clearing between turns: once the conversation
    // grows past the bound, consumed tool messages (older than the newest
    // pair) are dropped. Prompt-cache safe: the stable PREFIX (system +
    // context) is untouched; only post-prefix tool messages trim. The
    // newest pair stays so the model always sees its latest outcomes.
    // FL-2.17 - checkpoint state: the FULL provider conversation + loop
    // counters, written every tool turn through the Engine claim-check
    // (PutRunArtifact + SaveCheckpointRef). A re-driven execution reads it
    // back and resumes the loop instead of replaying the whole conversation.
    const writeCheckpoint = async (): Promise<void> => {
      try {
        const state = JSON.stringify({
          messages,
          turn,
          totalPrompt,
          totalCompletion,
          toolCallsExecuted,
        });
        const put = (await client.putRunArtifact({
          purpose: 'CHECKPOINT',
          mediaType: 'application/json',
          data: Buffer.from(state, 'utf8'),
        })) as {
          artifact?: {
            artifactId?: string;
            uri?: string;
            mediaType?: string;
            byteLength?: bigint | number;
            sha256?: Uint8Array;
          };
        };
        const art = put.artifact;
        if (!art || !art.artifactId || !art.uri) {
          return;
        }
        await client.saveCheckpointRef({
          checkpointId: input.runId,
          checkpointVersion: turn,
          artifactRef: create(ArtifactRefSchema, {
            artifactId: art.artifactId,
            uri: art.uri,
            mediaType: art.mediaType ?? 'application/json',
            byteLength: BigInt(Number(art.byteLength ?? 0)),
            sha256: art.sha256 ?? new Uint8Array(),
            encryptionKeyId: '',
          }) as ArtifactRef,
        });
      } catch {
        // Checkpointing is best-effort durability — never fails the run.
      }
    };

    // FL-2.13 - oversized tool results: past the inline bound, the result is
    // written through the Engine claim-check and the tool message carries a
    // bounded ArtifactRef descriptor instead of raw content.
    const maybeClaimCheck = async (
      toolCallId: string,
      entry: ToolTurnEntry,
    ): Promise<ToolTurnEntry> => {
      const text = JSON.stringify(entry.result ?? null);
      if (text.length <= TOOL_MESSAGE_MAX_CHARS) {
        return entry;
      }
      try {
        const put = (await client.putRunArtifact({
          purpose: 'TOOL_RESULT',
          mediaType: 'application/json',
          data: Buffer.from(text, 'utf8'),
        })) as {
          artifact?: { artifactId?: string; byteLength?: bigint | number; sha256?: Uint8Array };
        };
        const art = put.artifact;
        if (art && art.artifactId) {
          return {
            ...entry,
            result: {
              claim_check: {
                artifact_id: art.artifactId,
                byte_length: Number(art.byteLength ?? 0),
                sha256_hex: art.sha256 ? Buffer.from(art.sha256).toString('hex') : '',
              },
              note: 'result exceeded the inline bound - fetch via GetRunArtifact',
            },
          };
        }
      } catch {
        // fall through to the bounded inline form
      }
      return entry;
    };

    let totalPrompt = 0;
    let totalCompletion = 0;
    let turn = 0;
    let toolCallsExecuted = 0;
    let resultText = '';

    // FL-2.17 - resume-from-checkpoint: if a previous execution of this run
    // checkpointed its loop state, restore the conversation + counters and
    // continue from that turn instead of replaying from scratch. A stale or
    // unreadable checkpoint silently falls back to a fresh compile.
    let resumeTurn = 0;
    try {
      const cp = (await client.getLatestCheckpoint()) as {
        checkpointRef: string;
        checkpointVersion?: bigint | number;
        artifact: { artifactId: string };
      } | null;
      if (cp !== null && cp.checkpointRef.length > 0 && cp.artifact.artifactId.length > 0) {
        const artifact = (await client.getRunArtifact({ artifactId: cp.artifact.artifactId })) as {
          accessUrl: string;
        };
        if (artifact.accessUrl) {
          const res = await fetch(artifact.accessUrl);
          if (res.ok) {
            const parsed = JSON.parse(await res.text()) as {
              messages?: NeryvaMessage[];
              turn?: number;
              totalPrompt?: number;
              totalCompletion?: number;
              toolCallsExecuted?: number;
            };
            if (
              Array.isArray(parsed.messages) &&
              parsed.messages.length > 0 &&
              typeof parsed.turn === 'number'
            ) {
              messages.splice(0, messages.length, ...parsed.messages);
              resumeTurn = Math.max(0, Math.min(parsed.turn, MAX_TURNS));
              totalPrompt = Number(parsed.totalPrompt ?? 0);
              totalCompletion = Number(parsed.totalCompletion ?? 0);
              toolCallsExecuted = Number(parsed.toolCallsExecuted ?? 0);
            }
          }
        }
      }
    } catch {
      // No readable checkpoint - fresh start.
    }

    const trimToolMessages = (): void => {
      const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
      const totalChars = messages.reduce(
        (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
        0,
      );
      if (toolIdx.length <= 2 || totalChars <= 24_000) {
        return;
      }
      const drop = new Set(toolIdx.slice(0, toolIdx.length - 2));
      for (let i = messages.length - 1; i >= 0; i--) {
        if (drop.has(i)) messages.splice(i, 1);
      }
    };

    // FL-1.6 — vision input: fetch the trigger message's image attachments
    // via the Engine claim-check (GetRunArtifact + presigned URL) and convert
    // the last user message to multimodal parts. Unknown media / oversized /
    // tampered attachments are rejected BEFORE the provider call (skip +
    // RunWarning — the run continues with the remaining parts).
    const triggerUserMessage = [...recent].reverse().find((m) => m.role === 'user');
    const attachments = (triggerUserMessage?.attachments ?? []).slice(0, 4);
    const fetchedImages: Array<{ mediaType: string; dataBase64: string }> = [];
    for (const att of attachments) {
      const reject = async (reason: string): Promise<void> => {
        await client.appendRunEvents([
          event(input, 'RunWarning', {
            kind: 'RunWarning',
            runId: input.runId,
            code: 'ATTACHMENT_REJECTED',
            messageHash: `artifact ${att.artifactId.slice(0, 8)}: ${reason}`,
          }),
        ]);
      };
      if (!IMAGE_MEDIA_TYPES.has(att.mediaType)) {
        await reject(`media type ${att.mediaType} not supported`);
        continue;
      }
      if (att.byteLength > MAX_ATTACHMENT_BYTES) {
        await reject(`exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
        continue;
      }
      try {
        const res = (await client.getRunArtifact({ artifactId: att.artifactId })) as {
          artifact?: {
            organizationId?: string;
            runId?: string;
            purpose?: string;
            byteLength?: bigint | number;
          };
          accessUrl?: string;
        };
        if (!res.accessUrl || !res.artifact) {
          await reject('claim-check denied');
          continue;
        }
        if (res.artifact.organizationId && res.artifact.organizationId !== input.organizationId) {
          await reject('cross-tenant ref');
          continue;
        }
        if (res.artifact.runId && res.artifact.runId !== input.runId) {
          await reject('wrong-run ref');
          continue;
        }
        const imgRes = await fetch(res.accessUrl, { signal: controller.signal });
        if (!imgRes.ok) {
          await reject(`presigned fetch HTTP ${imgRes.status}`);
          continue;
        }
        const bytes = new Uint8Array(await imgRes.arrayBuffer());
        if (bytes.byteLength !== att.byteLength) {
          await reject(`byteLength mismatch ${bytes.byteLength} != ${att.byteLength}`);
          continue;
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        const expected = att.sha256 ? Buffer.from(att.sha256).toString('hex') : '';
        if (expected && digest !== expected) {
          await reject('sha256 mismatch');
          continue;
        }
        fetchedImages.push({
          mediaType: att.mediaType,
          dataBase64: Buffer.from(bytes).toString('base64'),
        });
      } catch {
        await reject('fetch failed');
      }
    }
    if (fetchedImages.length > 0) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        const target = messages[lastUserIdx];
        if (target) {
          messages[lastUserIdx] = toImagePartsMessage(target, fetchedImages);
        }
      }
    }

    /** Between-turn budget check — returns the breached dimension or null. */
    const budgetBreach = (): string | null => {
      if (totalPrompt + totalCompletion > maxTotalTokens) return 'max_total_tokens';
      if (Date.now() >= wallClockDeadlineMs) return 'wall_clock_seconds';
      if (
        maxCostMicros > 0 &&
        costMicrosPer1kTokens > 0 &&
        ((totalPrompt + totalCompletion) / 1000) * costMicrosPer1kTokens > maxCostMicros
      ) {
        return 'max_cost_micros';
      }
      return null;
    };

    async function failBudgetExhausted(dimension: string): Promise<void> {
      terminal = 'FAILED_BUDGET';
      await client.appendRunEvents([
        event(input, 'RunWarning', {
          kind: 'RunWarning',
          runId: input.runId,
          code: 'BUDGET_EXHAUSTED',
          messageHash: `budget dimension exhausted: ${dimension}`,
        }),
      ]);
      await client.failRun({
        errorCode: 'BUDGET_EXHAUSTED',
        errorMessage: `budget dimension exhausted: ${dimension}`,
        expectedVersion: expectedRunVersion,
      });
    }

    /** FL-1.4 — a blocked surface fails the run; content never reaches Engine. */
    async function failGuardrailBlocked(
      direction: 'input' | 'output',
      categories: string[],
    ): Promise<void> {
      await client.appendRunEvents([
        event(input, 'RunWarning', {
          kind: 'RunWarning',
          runId: input.runId,
          code: direction === 'input' ? 'GUARDRAIL_BLOCKED_INPUT' : 'GUARDRAIL_BLOCKED_OUTPUT',
          // Category names only — no prompt or output content in events (SEC).
          messageHash: `moderation categories: ${categories.join(',')}`,
        }),
      ]);
      await client.failRun({
        errorCode: 'GUARDRAIL_BLOCKED',
        errorMessage: `${direction} blocked by guardrail policy`,
        expectedVersion: expectedRunVersion,
      });
    }

    /** Execute one approved, allowlisted tool call through the Gateway. */
    async function executeToolCall(
      call: { id: string; name: string; args: unknown },
      stepId: string,
    ): Promise<ToolTurnEntry & { __oversized?: boolean }> {
      // Per-call budget counter — the run stops opening new tool effects
      // once the pinned max_tool_calls is spent.
      if (toolCallsExecuted >= maxToolCalls) {
        return {
          tool_call_id: call.id,
          tool: call.name,
          status: 'FAILED',
          result: { error: 'BUDGET_EXHAUSTED', dimension: 'max_tool_calls' },
        };
      }
      await client.authorizeToolCall({
        toolCallId: call.id,
        stepId,
        toolName: call.name,
        toolVersion: '1.0.0',
        argumentDigest: argsDigest(call.args),
      });
      const res = await toolGateway.execute({
        proposal: { toolName: call.name, args: call.args, toolCallId: call.id },
        context: toolContext,
        stepId,
        runId: input.runId,
        policyVersion: toolContext.policyVersion,
        rateLimits: { maxCallsPerRun: maxToolCalls, currentCalls: toolCallsExecuted },
        // Unbound tool executors fail closed: without a real executor the
        // gateway must NOT pretend the call succeeded.
        handlerOverride: async (args, ctx) => {
          const bound = boundHandlers.get(call.name);
          if (!bound) {
            // Unbound tool executors fail closed: without a real executor the
            // gateway must NOT pretend the call succeeded.
            throw new Error('TOOL_EXECUTOR_UNBOUND: no executor bound for this tool');
          }
          return bound(args, ctx);
        },
      });
      toolCallsExecuted += 1;
      await client.recordToolOutcome({
        toolCallId: call.id,
        stepId,
        status: res.outcome,
        resultDigest: resultDigest(res.result),
      });
      const entry: ToolTurnEntry = {
        tool_call_id: call.id,
        tool: call.name,
        status: res.success ? 'EXECUTED' : 'FAILED',
        result: res.success
          ? res.result
          : { error: res.errorCode ?? 'TOOL_FAILED', detail: res.result },
      };
      if (JSON.stringify(res.result ?? null).length > TOOL_MESSAGE_MAX_CHARS) {
        // FL-2.13 — claim-check the oversized result through the Engine.
        const claimed = await maybeClaimCheck(call.id, entry);
        return { ...claimed, __oversized: true };
      }
      return entry;
    }

    turn = resumeTurn;
    while (turn < MAX_TURNS) {
      // Cancellation between turns (FL-1.3): Engine already marked the run
      // CANCELED — stop quietly, no commit (a terminal run rejects it). A
      // wall-clock abort on the same controller is a budget failure instead.
      if (isAborted()) {
        if (isBudgetAbort()) {
          await failBudgetExhausted('wall_clock_seconds');
        } else {
          terminal = 'CANCELLED';
        }
        break;
      }
      const breach = budgetBreach();
      if (breach) {
        await failBudgetExhausted(breach);
        terminal = 'FAILED_BUDGET';
        break;
      }

      turn += 1;
      // FL-3.14 — GenAI semconv model span at the gateway boundary (redaction
      // applies inside telemetry; no prompt/completion content on the span).
      const correlation: CorrelationContext = {
        runId: input.runId,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        agentVersionId: input.agentVersionId,
        correlationId: input.runId,
        stepId: `turn-${turn}`,
      };
      const modelSpan = startSpan({
        kind: 'model',
        name: 'agent-run-model-call',
        correlation,
        attributes: {
          'gen_ai.provider.name': 'litellm',
          'gen_ai.request.model': compiled.providerRequest.model,
          'gen_ai.turn': turn,
        },
      });
      const stream = await gateway.stream(
        { ...compiled.providerRequest, messages, tools },
        { signal: controller.signal },
      );
      let buffer = '';
      let lastEmit = Date.now();

      const flush = async (isFinal: boolean): Promise<void> => {
        if (!buffer && !isFinal) return;
        const text = buffer;
        buffer = '';
        await client.appendRunEvents([
          event(input, 'AssistantChunk', {
            kind: 'AssistantChunk',
            runId: input.runId,
            text,
            isFinal,
          }),
        ]);
      };

      let finishReason = 'stop';
      let finalText = '';
      const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;
      try {
        for await (const ev of stream.stream) {
          if (ev.type === 'text-delta') {
            buffer += ev.delta;
            finalText += ev.delta;
            if (buffer.length >= CHUNK_CHARS || Date.now() - lastEmit >= CHUNK_MS) {
              await flush(false);
              lastEmit = Date.now();
            }
          } else if (ev.type === 'tool-call') {
            const raw = ev.toolCall as {
              id: string;
              name: string;
              args?: unknown;
              argsJson?: string | undefined;
            };
            toolCalls.push({
              id: raw.id,
              name: raw.name,
              args: raw.args ?? (raw.argsJson ? (JSON.parse(raw.argsJson) as unknown) : {}),
            });
          } else if (ev.type === 'finish') {
            finishReason = ev.finishReason;
            if (ev.usage) {
              streamUsage = {
                promptTokens: Number(ev.usage.promptTokens),
                completionTokens: Number(ev.usage.completionTokens),
              };
            }
          }
        }
      } catch (err) {
        // Cancellation mid-stream (FL-1.3): the gateway surfaces abort as an
        // error — distinguish a cancel (Engine owns the terminal state) from
        // a wall-clock abort (budget failure).
        if (isBudgetAbort()) {
          endSpan(modelSpan, err instanceof Error ? err : new Error('budget_abort'));
          await failBudgetExhausted('wall_clock_seconds');
          break;
        }
        if (isAborted()) {
          endSpan(modelSpan, err instanceof Error ? err : new Error('cancelled'));
          terminal = 'CANCELLED';
          break;
        }
        if (err instanceof Error) {
          endSpan(modelSpan, err);
        }
        throw err;
      }
      await flush(true);
      const final = stream.finalResponse ? await stream.finalResponse : undefined;
      if (final?.usage) {
        totalPrompt += Number(final.usage.promptTokens);
        totalCompletion += Number(final.usage.completionTokens);
      } else if (streamUsage) {
        totalPrompt += streamUsage.promptTokens;
        totalCompletion += streamUsage.completionTokens;
      }
      // FL-3.14 — usage rides the span per semconv (input/output tokens).
      modelSpan.setAttribute('gen_ai.usage.input_tokens', totalPrompt);
      modelSpan.setAttribute('gen_ai.usage.output_tokens', totalCompletion);
      endSpan(modelSpan);

      if (finishReason === 'tool-call' && toolCalls.length > 0) {
        // Classify every proposed call against the pinned set FIRST — the
        // model's output cannot widen the tool surface mid-turn.
        const entries = new Map<string, ToolTurnEntry>();
        const notAllowlisted: string[] = [];
        const allowlisted = toolCalls.filter((c) => {
          if (toolPolicies.has(c.name)) return true;
          notAllowlisted.push(c.name);
          entries.set(c.id, {
            tool_call_id: c.id,
            tool: c.name,
            status: 'NOT_ALLOWLISTED',
            result: { error: 'TOOL_NOT_ALLOWLISTED' },
          });
          return false;
        });
        if (notAllowlisted.length > 0) {
          await client.appendRunEvents([
            event(input, 'RunWarning', {
              kind: 'RunWarning',
              runId: input.runId,
              code: 'TOOL_NOT_ALLOWLISTED',
              messageHash: `not in pinned set: ${notAllowlisted.join(',')}`,
            }),
          ]);
        }

        // Approval subset — one decision check per call; a still-pending
        // approval parks the WHOLE turn (deterministic re-drive replays it;
        // Engine toolEffects dedup makes replays safe).
        const pendingApprovals: Array<{ call: (typeof allowlisted)[number]; approvalId: string }> =
          [];
        for (const call of allowlisted) {
          const descriptor = toolPolicies.get(call.name);
          if (descriptor?.approvalRequirement !== 'REQUIRED') continue;
          const approvalId = `aprv_${input.runId}_${turn}_${call.id}`.slice(0, 64);
          const stateRes = (await client.getApprovalState({ approvalRef: approvalId })) as {
            state?: string;
          } | null;
          const state = stateRes?.state ?? 'NOT_FOUND';
          if (state === 'APPROVED') continue; // decided — proceed to execution
          if (state === 'DENIED' || state === 'EXPIRED') {
            entries.set(call.id, {
              tool_call_id: call.id,
              tool: call.name,
              status: 'DENIED',
              result: { error: `APPROVAL_${state}` },
            });
            await client.appendRunEvents([
              event(input, 'ApprovalReceived', {
                kind: 'ApprovalReceived',
                runId: input.runId,
                approvalId,
                decision: state,
              }),
            ]);
            continue;
          }
          pendingApprovals.push({ call, approvalId });
        }
        if (pendingApprovals.length > 0) {
          for (const { call, approvalId } of pendingApprovals) {
            await client.createApprovalRequest({
              approvalId,
              toolCallId: call.id,
              summary: `Tool ${call.name} requested by run ${input.runId}`,
              actionType: call.name,
            });
            await client.appendRunEvents([
              event(input, 'ApprovalRequested', {
                kind: 'ApprovalRequested',
                runId: input.runId,
                approvalId,
                toolCallId: call.id,
              }),
            ]);
          }
          terminal = 'PARKED_APPROVAL';
          break; // durable pause — Engine re-drives the run on the decision
        }

        const runnable = allowlisted.filter((c) => !entries.has(c.id));
        // Wave 1 — READ_ONLY calls run concurrently; wave 2 — MUTATING/
        // DESTRUCTIVE calls serialize in proposal order (effect policy).
        const readOnly = runnable.filter(
          (c) => toolPolicies.get(c.name)?.effectClass === 'READ_ONLY',
        );
        const mutating = runnable.filter(
          (c) => toolPolicies.get(c.name)?.effectClass !== 'READ_ONLY',
        );
        const readOnlyResults = await Promise.all(
          readOnly.map((call, i) => {
            const stepId = `${input.runId}:t${turn}:r${i}`;
            return executeToolCall(call, stepId).catch((err: unknown) => ({
              tool_call_id: call.id,
              tool: call.name,
              status: 'FAILED' as const,
              result: { error: err instanceof Error ? err.message : 'TOOL_FAILED' },
            }));
          }),
        );
        for (const r of readOnlyResults) entries.set(r.tool_call_id, r);
        for (const [i, call] of mutating.entries()) {
          const stepId = `${input.runId}:t${turn}:m${i}`;
          const r = await executeToolCall(call, stepId).catch((err: unknown) => ({
            tool_call_id: call.id,
            tool: call.name,
            status: 'FAILED' as const,
            result: { error: err instanceof Error ? err.message : 'TOOL_FAILED' },
          }));
          entries.set(r.tool_call_id, r);
        }

        // Per-call budget breach mid-turn — the tool spend is bounded; when
        // the model still wants more tools the run fails (never loops on
        // refused calls).
        if (toolCallsExecuted >= maxToolCalls) {
          await failBudgetExhausted('max_tool_calls');
          break;
        }

        // ONE bounded tool message per turn joins every result (FL-1.1).
        const ordered = toolCalls
          .map((c) => entries.get(c.id))
          .filter((e): e is ToolTurnEntry => e !== undefined)
          .map(boundEntry);
        if (finalText) {
          messages.push({ role: 'assistant', content: finalText });
        }
        messages.push({
          role: 'tool',
          content: JSON.stringify(ordered).slice(0, TOOL_MESSAGE_MAX_CHARS),
          toolCallId: toolCalls[0]?.id ?? '',
          name: toolCalls[0]?.name ?? '',
        });
        trimToolMessages();
        await writeCheckpoint();
        continue;
      }

      resultText = finalText || (final?.text ?? '');
      break;
    }

    if (terminal === 'CANCELLED' || terminal === 'PARKED_APPROVAL') {
      // Engine owns both terminal paths (CANCELED / WAITING_APPROVAL):
      // no commit, no failRun — release the lease and return.
      try {
        await client.releaseRunLease(leaseEpoch);
      } catch {
        // Lease expiry is the safety net.
      }
      return { resultText: '' };
    }

    if (terminal === 'FAILED_BUDGET') {
      try {
        await client.releaseRunLease(leaseEpoch);
      } catch {
        // Lease expiry is the safety net.
      }
      return { resultText: '' };
    }

    if (!resultText) {
      resultText = 'The run ended without producing a result.';
    }

    // FL-1.4 — assistant output screening before the terminal commit.
    const outputBlocked = await moderateContent(
      moderationHook,
      guardrailPolicy,
      resultText,
      'output',
    );
    if (outputBlocked) {
      terminal = 'FAILED_GUARDRAIL';
      await failGuardrailBlocked('output', outputBlocked.categories);
      try {
        await client.releaseRunLease(leaseEpoch);
      } catch {
        // Lease expiry is the safety net.
      }
      return { resultText: '' };
    }

    // FL-3.4 — suggested follow-ups (policy-gated): one bounded structured
    // completion over the final reply; any failure degrades to none. Counts
    // against the run budget like any other model call.
    let suggestedFollowups: string[] | undefined;
    if (manifest.modelParams?.followup_suggestions === true && resultText.trim().length > 0) {
      try {
        const followupRes = await gateway.generate(
          {
            model: compiled.providerRequest.model,
            messages: [
              {
                role: 'system',
                content:
                  'Given the assistant reply, produce up to 3 short follow-up questions the user might realistically ask next (max 200 chars each). Output only JSON: {"questions": ["...", "..."]}.',
              },
              { role: 'user', content: resultText.slice(0, 2000) },
            ],
            structuredOutput: {
              name: 'followups',
              schema: {
                type: 'object',
                properties: {
                  questions: {
                    type: 'array',
                    items: { type: 'string', maxLength: 200 },
                    maxItems: 3,
                  },
                },
                required: ['questions'],
                additionalProperties: false,
              },
            },
          },
          { signal: controller.signal },
        );
        const questions = (followupRes.structuredOutput as { questions?: unknown } | undefined)
          ?.questions;
        if (Array.isArray(questions)) {
          suggestedFollowups = questions
            .filter((q): q is string => typeof q === 'string')
            .map((q) => q.trim().slice(0, 200))
            .filter((q) => q.length > 0)
            .slice(0, 3);
        }
        totalPrompt += followupRes.usage.promptTokens;
        totalCompletion += followupRes.usage.completionTokens;
      } catch {
        // Follow-ups are best-effort — never fail the run for them.
      }
    }

    // 5. Terminal commit — usage rides the commit (single ledger entry).
    await client.commitRunResult({
      resultText,
      expectedVersion: expectedRunVersion,
      usage: {
        provider: 'litellm',
        model: compiled.providerRequest.model,
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
      },
      ...(suggestedFollowups && suggestedFollowups.length > 0 ? { suggestedFollowups } : {}),
    });

    // 6. Compaction — summarize when the conversation has grown past the
    // threshold. Engine stores it; the next run's manifest serves it.
    if (recent.length >= SUMMARY_SOURCE_THRESHOLD && !manifest.conversationSummary) {
      try {
        const transcript = recent
          .map((m) => `${m.role}: ${m.text}`)
          .join('\n')
          .slice(0, 24_000);
        const summaryRes = await gateway.generate(
          {
            model: compiled.providerRequest.model,
            messages: [
              {
                role: 'system',
                content:
                  'Summarize the conversation so far in under 300 words. Preserve facts, decisions, user preferences, and open questions. Output only the summary.',
              },
              { role: 'user', content: transcript },
            ],
          },
          { signal: controller.signal },
        );
        if (summaryRes.text) {
          await client.saveConversationSummary({
            sourceSequence: recent.length,
            summary: summaryRes.text.slice(0, 8192),
            tokenCount: Number(summaryRes.usage.totalTokens),
            modelId: summaryRes.model,
          });
        }
      } catch {
        // Compaction is best-effort — never fail the run for it.
      }
    }

    try {
      await client.releaseRunLease(leaseEpoch);
    } catch {
      // Lease expiry is the safety net.
    }
    return { resultText };
  }
}
