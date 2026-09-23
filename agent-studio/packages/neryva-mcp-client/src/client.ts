/**
 * client.ts — domain-facing Neryva MCP client
 * Source: agent_studio_implementation_plan.md:632-662, 644-657
 * Layers: generated transport → interceptors → scope/capability verifier → retry/idempotency → claim-check → domain client
 * Uses the REAL generated RunAuthorityService from @neryva/mcp-contract (never hand-copied).
 * Never allows caller to override scope fields: every RequestContext is built exclusively
 * from the Engine-granted scope captured at construction; caller input can only supply
 * method-specific logical keys (stepId/toolCallId/approvalId), never tenant scope.
 */

import { createClient, type Transport } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  RunAuthorityService,
  RunObservationService,
  GetRunArtifactRequestSchema,
  GetRunRequestSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js';
import {
  AcquireOrRenewRunLeaseRequestSchema,
  CommitRunResultRequestSchema,
  FailRunRequestSchema,
  ReleaseRunLeaseRequestSchema,
  SubmitMemoryProposalRequestSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js';
import { RequestContextSchema } from '@neryva/mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js';
import type { ArtifactRef } from '@neryva/mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js';
import { AppendRunEventsRequestSchema } from '@neryva/mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js';
import {
  GetAuthorizedRunContextRequestSchema,
  SearchKnowledgeRequestSchema,
  SaveConversationSummaryRequestSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/context/v1/context_pb.js';
import {
  GetApprovalStateRequestSchema,
  RequestHumanHandoffRequestSchema,
  PutRunArtifactRequestSchema,
  GetLatestCheckpointRequestSchema,
  GetToolCredentialRequestSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js';
import { validateRuntimeEvent, type RuntimeEvent } from '@neryva/contracts/events/runtime-events';
import { toMcpRunEvent } from './event-mapper.js';
import {
  ApprovalRequestSchema,
  ApprovalState,
  CreateApprovalRequestSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/approval/v1/approval_pb.js';
import {
  AuthorizeToolCallRequestSchema,
  RecordToolOutcomeRequestSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/tool/v1/tool_pb.js';
import { SaveCheckpointRequestSchema } from '@neryva/mcp-contract/gen/ts/neryva/mcp/checkpoint/v1/checkpoint_pb.js';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import type { CapabilityToken } from './capability.js';
import { assertScopeImmutability, validateScopeFields } from '@neryva/security';
import { withRetry } from './retry.js';
import { mapConnectError } from './error-mapping.js';

export interface NeryvaMcpClientOptions {
  transport: Transport;
  capability: CapabilityToken;
  /**
   * Raw Engine-issued capability JWT, presented as `Authorization: Bearer` on
   * every RPC. The Engine verifies this signature; the local CapabilityToken
   * above is the Studio-side decoded view used for fail-closed scope checks.
   * Required for any RPC the Engine authorizes (currently all of them).
   */
  capabilityJwt?: string | undefined;
  /** Engine-granted scope — the ONLY source of tenant fields on every request. */
  grantedScope: {
    organizationId: string;
    conversationId: string;
    runId: string;
    agentVersionId: string;
    actorId: string;
  };
  protocolVersion?: string;
  correlationId?: string;
}

/**
 * Deterministic idempotency key derived from run + method + logical operation key.
 * Retries of the same logical operation produce the SAME key (Engine dedups);
 * two distinct operations always produce different keys. Never wall-clock based.
 */
export function deriveRpcIdempotencyKey(params: {
  runId: string;
  method: string;
  logicalKey?: string | undefined;
}): string {
  const raw = `${params.runId}:${params.method}:${params.logicalKey ?? '0'}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 48);
}

export class NeryvaMcpClient {
  private readonly authority: {
    acquireOrRenewRunLease: (req: never) => Promise<unknown>;
    getAuthorizedRunContext: (req: never) => Promise<unknown>;
    searchKnowledge: (req: never) => Promise<unknown>;
    saveConversationSummary: (req: never) => Promise<unknown>;
    appendRunEvents: (req: never) => Promise<unknown>;
    createApprovalRequest: (req: never) => Promise<unknown>;
    getApprovalState: (req: never) => Promise<unknown>;
    requestHumanHandoff: (req: never) => Promise<unknown>;
    putRunArtifact: (req: never) => Promise<unknown>;
    getToolCredential: (req: never) => Promise<unknown>;
    getLatestCheckpoint: (req: never) => Promise<unknown>;
    submitMemoryProposal: (req: never) => Promise<unknown>;
    authorizeToolCall: (req: never) => Promise<unknown>;
    recordToolOutcome: (req: never) => Promise<unknown>;
    saveCheckpointRef: (req: never) => Promise<unknown>;
    commitRunResult: (req: never) => Promise<unknown>;
    failRun: (req: never) => Promise<unknown>;
    releaseRunLease: (req: never) => Promise<unknown>;
  };
  private readonly observation: {
    getRunArtifact: (req: never) => Promise<unknown>;
    getRun: (req: never) => Promise<unknown>;
  };
  private readonly grantedScope: NeryvaMcpClientOptions['grantedScope'];
  private readonly protocolVersion: string;
  private readonly correlationId: string;

  constructor(private readonly opts: NeryvaMcpClientOptions) {
    // Fail closed on incomplete scope — a partial scope must never reach the wire.
    const scopeCheck = validateScopeFields(opts.grantedScope);
    if (!scopeCheck.ok) {
      throw new Error(`incomplete granted scope: missing ${scopeCheck.field}`);
    }
    if (!opts.capability.capabilityId) {
      throw new Error('capability.capabilityId is required');
    }
    this.grantedScope = opts.grantedScope;
    this.protocolVersion = opts.protocolVersion ?? '1.0';
    this.correlationId = opts.correlationId ?? opts.grantedScope.runId;
    // Present the Engine-issued capability JWT as Authorization: Bearer on
    // every RPC. The Engine verifies the signature server-side; without this
    // header every authorized RPC fails with permission_denied. Applied as a
    // transport wrapper so it covers unary and streaming calls alike.
    const jwt = opts.capabilityJwt;
    const authedTransport: Transport = {
      unary: (method, signal, timeoutMs, header, input, contextValues) => {
        const headers = new Headers(header ?? undefined);
        if (jwt) headers.set('authorization', `Bearer ${jwt}`);
        return opts.transport.unary(method, signal, timeoutMs, headers, input, contextValues);
      },
      stream: (method, signal, timeoutMs, header, input, contextValues) => {
        const headers = new Headers(header ?? undefined);
        if (jwt) headers.set('authorization', `Bearer ${jwt}`);
        return opts.transport.stream(method, signal, timeoutMs, headers, input, contextValues);
      },
    };
    // Cast: the generated service descriptor's I/O types come from the remote es plugin
    // generation; Connect accepts the descriptor at runtime. Conformance tests pin shape.
    this.authority = createClient(RunAuthorityService as never, authedTransport as never) as never;
    // Observation surface (safe reads: GetRun / ListRunEvents / GetRunArtifact)
    // shares the transport and the capability token presented per call.
    this.observation = createClient(RunObservationService as never, authedTransport as never) as never;
  }

  /**
   * Build the per-RPC envelope. Tenant fields come ONLY from granted scope; the
   * immutability assertion re-verifies the constructed envelope against the scope so an
   * accidental widening is a loud failure, not silent behavior.
   */
  private buildRequestContext(method: string, logicalKey?: string | undefined) {
    const ctx = create(RequestContextSchema, {
      requestId: uuidv7(),
      organizationId: this.grantedScope.organizationId,
      conversationId: this.grantedScope.conversationId,
      runId: this.grantedScope.runId,
      actorId: this.grantedScope.actorId,
      idempotencyKey: deriveRpcIdempotencyKey({
        runId: this.grantedScope.runId,
        method,
        logicalKey,
      }),
      protocolVersion: this.protocolVersion,
      capabilityId: this.opts.capability.capabilityId,
    });
    assertScopeImmutability(this.grantedScope, {
      organizationId: ctx.organizationId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      agentVersionId: this.grantedScope.agentVersionId,
    });
    return ctx;
  }

  private callIdempotent<R>(fn: () => Promise<R>): Promise<R> {
    return withRetry(fn).catch((e: unknown) => {
      throw mapConnectError(e);
    });
  }

  // Domain methods → RPCs (agent_studio_implementation_plan.md:644-657)

  /** claimRun → AcquireOrRenewRunLease. Idempotent per run. */
  async claimRun(params: {
    expectedLeaseOwner?: string | undefined;
    expectedLeaseEpoch?: bigint | undefined;
    renewUntil?: Date | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('AcquireOrRenewRunLease', 'claim');
    const req = create(AcquireOrRenewRunLeaseRequestSchema, {
      ctx,
      expectedLeaseOwner: params.expectedLeaseOwner ?? '',
      expectedLeaseEpoch: params.expectedLeaseEpoch ?? 0n,
      renewUntil: params.renewUntil ? toTimestamp(params.renewUntil) : undefined,
    });
    return this.callIdempotent(() => this.authority.acquireOrRenewRunLease(req as never));
  }

  /** getAuthorizedRunContext → GetAuthorizedRunContext (all context sub-operations). */
  async getAuthorizedRunContext(requestedPurposes: string[] = []): Promise<unknown> {
    const ctx = this.buildRequestContext('GetAuthorizedRunContext');
    const req = create(GetAuthorizedRunContextRequestSchema, {
      ctx,
      requestedPurposes,
    });
    return this.callIdempotent(() => this.authority.getAuthorizedRunContext(req as never));
  }

  /**
   * appendRunEvents → AppendRunEvents. Accepts domain RuntimeEvents, maps them to the
   * generated RunEvent at this protocol boundary. Idempotent: the idempotency key is
   * derived from the batch's own stable event IDs, so a redelivered batch re-derives the
   * same key and Engine dedups. Batch bounded to 1..32 per event emission rules.
   */
  async appendRunEvents(events: RuntimeEvent[]): Promise<unknown> {
    if (events.length === 0 || events.length > 32) {
      throw new Error('event batch must be 1..32');
    }
    for (const e of events) validateRuntimeEvent(e);
    const protoEvents = events.map(toMcpRunEvent);
    const ctx = this.buildRequestContext(
      'AppendRunEvents',
      events
        .map((e) => e.eventId)
        .sort()
        .join(','),
    );
    const req = create(AppendRunEventsRequestSchema, { ctx, events: protoEvents });
    return this.callIdempotent(() => this.authority.appendRunEvents(req as never));
  }

  /** createApprovalRequest → CreateApprovalRequest. Idempotent per approval. */
  async createApprovalRequest(params: {
    approvalId: string;
    toolCallId: string;
    summary?: string | undefined;
    actionType?: string | undefined;
    policyVersion?: string | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('CreateApprovalRequest', params.approvalId);
    const approval = create(ApprovalRequestSchema, {
      approvalId: params.approvalId,
      organizationId: this.grantedScope.organizationId,
      runId: this.grantedScope.runId,
      summary: params.summary ?? '',
      actionType: params.actionType ?? 'tool_call',
      policyVersion: params.policyVersion ?? '',
      state: ApprovalState.PENDING,
    });
    const req = create(CreateApprovalRequestSchema, { ctx, approval });
    return this.callIdempotent(() => this.authority.createApprovalRequest(req as never));
  }

  /** submitMemoryProposal → SubmitMemoryProposal. Idempotent per proposal. */
  async submitMemoryProposal(params: {
    proposalId: string;
    scope?: string | undefined;
    value: string;
    provenance?: string | undefined;
    confidence?: number | undefined;
    visibility?: string | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('SubmitMemoryProposal', params.proposalId);
    const req = create(SubmitMemoryProposalRequestSchema, {
      ctx,
      proposalId: params.proposalId,
      scope: params.scope ?? 'conversation',
      value: params.value,
      provenance: params.provenance ?? 'agent_proposal',
      confidence: params.confidence ?? 0,
      visibility: params.visibility ?? 'private',
    });
    return this.callIdempotent(() => this.authority.submitMemoryProposal(req as never));
  }

  /** authorizeToolCall → AuthorizeToolCall. Idempotent per step+toolCall. */
  async authorizeToolCall(params: {
    toolCallId: string;
    stepId: string;
    toolName: string;
    toolVersion: string;
    argumentDigest?: Uint8Array | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext(
      'AuthorizeToolCall',
      `${params.stepId}:${params.toolCallId}`,
    );
    const req = create(AuthorizeToolCallRequestSchema, {
      ctx,
      stepId: params.stepId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      toolVersion: params.toolVersion,
      argumentDigest: params.argumentDigest ?? new Uint8Array(),
    });
    return this.callIdempotent(() => this.authority.authorizeToolCall(req as never));
  }

  /** recordToolOutcome → RecordToolOutcome. Idempotent per step+toolCall. */
  async recordToolOutcome(params: {
    toolCallId: string;
    stepId: string;
    status: string;
    resultDigest?: Uint8Array | undefined;
    resultRef?: ArtifactRef | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext(
      'RecordToolOutcome',
      `${params.stepId}:${params.toolCallId}`,
    );
    const req = create(RecordToolOutcomeRequestSchema, {
      ctx,
      stepId: params.stepId,
      toolCallId: params.toolCallId,
      resultDigest: params.resultDigest ?? new Uint8Array(),
      status: params.status,
      resultRef: params.resultRef,
    });
    return this.callIdempotent(() => this.authority.recordToolOutcome(req as never));
  }

  /** saveCheckpointRef → SaveCheckpointRef. Idempotent per checkpoint version. */
  async saveCheckpointRef(params: {
    checkpointId: string;
    checkpointVersion: number;
    artifactRef: ArtifactRef;
    digest?: Uint8Array | undefined;
    createdAt?: Date | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext(
      'SaveCheckpointRef',
      `${params.checkpointId}:${params.checkpointVersion}`,
    );
    const req = create(SaveCheckpointRequestSchema, {
      ctx,
      checkpointId: params.checkpointId,
      checkpointVersion: BigInt(params.checkpointVersion),
      artifactRef: params.artifactRef,
      digest: params.digest ?? new Uint8Array(),
      createdAt: params.createdAt ? toTimestamp(params.createdAt) : undefined,
    });
    return this.callIdempotent(() => this.authority.saveCheckpointRef(req as never));
  }

  /**
   * commitRunResult → CommitRunResult. Idempotent with a STABLE per-run key:
   * retry after a lost response re-derives the same key, Engine returns the original
   * message — the assistant message can never be duplicated.
   */
  async commitRunResult(params: {
    resultText: string;
    expectedVersion?: bigint | undefined;
    resultArtifact?: ArtifactRef | undefined;
    usage?: {
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    /** v1.2 (FL-3.4) — bounded follow-up suggestions stored with the reply. */
    suggestedFollowups?: string[] | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('CommitRunResult', 'commit');
    const req = create(CommitRunResultRequestSchema, {
      ctx,
      expectedVersion: params.expectedVersion ?? 0n,
      resultText: params.resultText,
      resultArtifact: params.resultArtifact,
      usage: params.usage
        ? {
            provider: params.usage.provider,
            model: params.usage.model,
            promptTokens: BigInt(Math.max(0, Math.round(params.usage.promptTokens))),
            completionTokens: BigInt(Math.max(0, Math.round(params.usage.completionTokens))),
            totalTokens: BigInt(Math.max(0, Math.round(params.usage.totalTokens))),
          }
        : undefined,
      ...(params.suggestedFollowups && params.suggestedFollowups.length > 0
        ? {
            suggestedFollowups: params.suggestedFollowups
              .slice(0, 4)
              .map((f) => f.trim().slice(0, 200))
              .filter((f) => f.length > 0),
          }
        : {}),
    });
    return this.callIdempotent(() => this.authority.commitRunResult(req as never));
  }

  /**
   * searchKnowledge → SearchKnowledge (contract v1.1). Agentic mid-run
   * retrieval through the Engine's ACL-before-scoring path. Results are
   * bounded KnowledgeRefs with spotlighted snippets.
   */
  async searchKnowledge(params: {
    query: string;
    maxResults?: number | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('SearchKnowledge');
    const req = create(SearchKnowledgeRequestSchema, {
      ctx,
      query: params.query.slice(0, 512),
      maxResults: Math.min(Math.max(1, params.maxResults ?? 5), 20),
    });
    return this.callIdempotent(() => this.authority.searchKnowledge(req as never));
  }

  /**
   * saveConversationSummary → SaveConversationSummary (contract v1.1).
   * Engine stores the compaction summary as business truth; idempotent per
   * (conversation_id, source_sequence).
   */
  async saveConversationSummary(params: {
    sourceSequence: number;
    summary: string;
    tokenCount?: number | undefined;
    modelId?: string | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext(
      'SaveConversationSummary',
      `summary:${params.sourceSequence}`,
    );
    const req = create(SaveConversationSummaryRequestSchema, {
      ctx,
      sourceSequence: BigInt(params.sourceSequence),
      summary: params.summary.slice(0, 8192),
      tokenCount: Math.max(0, Math.floor(params.tokenCount ?? 0)),
      modelId: params.modelId ?? '',
    });
    return this.callIdempotent(() => this.authority.saveConversationSummary(req as never));
  }

  /**
   * getApprovalState → GetApprovalState (contract v1.2). Safe read of the
   * Engine's durable decision for a Studio-proposed approval_ref. Closes the
   * park/resume loop: a re-driven run checks the decision before re-parking.
   */
  async getApprovalState(params: { approvalRef: string }): Promise<unknown> {
    const ctx = this.buildRequestContext('GetApprovalState', `approval:${params.approvalRef}`);
    const req = create(GetApprovalStateRequestSchema, {
      ctx,
      approvalRef: params.approvalRef.slice(0, 64),
    });
    return this.callIdempotent(() => this.authority.getApprovalState(req as never));
  }

  /**
   * getRun → GetRun (RunObservationService). Returns the Engine's canonical
   * run record including the current version (CAS token). Used to refresh a
   * stale cached version after an external version bump (e.g. approval
   * decision WAITING_APPROVAL → RUNNING).
   */
  async getRun(): Promise<{ version?: unknown }> {
    const ctx = this.buildRequestContext('GetRun', 'run');
    const req = create(GetRunRequestSchema, { ctx });
    const res = (await this.callIdempotent(() => this.observation.getRun(req as never))) as {
      run?: { version?: unknown };
    };
    return { version: res.run?.version };
  }

  /**
   * getRunArtifact → GetRunArtifact (RunObservationService). Claim-check
   * read: the Engine re-validates scope + purpose + expiry and returns a
   * short-lived presigned access URL. Studio verifies checksum after fetch.
   */
  async getRunArtifact(params: { artifactId: string }): Promise<unknown> {
    const ctx = this.buildRequestContext('GetRunArtifact', `artifact:${params.artifactId}`);
    const req = create(GetRunArtifactRequestSchema, {
      ctx,
      artifactId: params.artifactId,
    });
    return this.callIdempotent(() => this.observation.getRunArtifact(req as never));
  }

  /**
   * requestHumanHandoff → RequestHumanHandoff (contract v1.2, FL-1.7c).
   * The built-in `request_human_handoff` tool lands here: Engine opens the
   * escalation, pauses the auto-responder, emits the lifecycle event.
   */
  async requestHumanHandoff(params: {
    reason: string;
    note?: string | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('RequestHumanHandoff', 'handoff');
    const req = create(RequestHumanHandoffRequestSchema, {
      ctx,
      reason: params.reason.slice(0, 128),
      ...(params.note !== undefined ? { note: params.note.slice(0, 1024) } : {}),
    });
    return this.callIdempotent(() => this.authority.requestHumanHandoff(req as never));
  }

  /**
   * putRunArtifact -> PutRunArtifact (contract v1.3, FL-2.13/2.17). Bounded
   * claim-check WRITE through the Engine; returns the ArtifactRef.
   */
  async putRunArtifact(params: {
    purpose: 'CHECKPOINT' | 'TOOL_RESULT' | 'GENERATED_MEDIA';
    mediaType: string;
    data: Uint8Array;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('PutRunArtifact', `artifact:${params.purpose}`);
    const req = create(PutRunArtifactRequestSchema, {
      ctx,
      purpose: params.purpose,
      mediaType: params.mediaType.slice(0, 128),
      data: params.data,
    });
    return this.callIdempotent(() => this.authority.putRunArtifact(req as never));
  }

  /**
   * getToolCredential -> GetToolCredential (contract v1.3, FL-2.10). Scoped
   * disclosure of a tool's customer-endpoint credential; audited Engine-side.
   */
  async getToolCredential(params: { toolName: string }): Promise<unknown> {
    const ctx = this.buildRequestContext('GetToolCredential', `toolcred:${params.toolName}`);
    const req = create(GetToolCredentialRequestSchema, {
      ctx,
      toolName: params.toolName.slice(0, 128),
    });
    return this.callIdempotent(() => this.authority.getToolCredential(req as never));
  }

  /** getLatestCheckpoint -> GetLatestCheckpoint (contract v1.3, FL-2.17). Safe read. */
  async getLatestCheckpoint(): Promise<unknown> {
    const ctx = this.buildRequestContext('GetLatestCheckpoint', 'checkpoint:latest');
    const req = create(GetLatestCheckpointRequestSchema, { ctx });
    return this.callIdempotent(() => this.authority.getLatestCheckpoint(req as never));
  }

  /** failRun → FailRun. Idempotent per run (terminal, version-fenced). */
  async failRun(params: {
    errorCode: string;
    errorMessage: string;
    expectedVersion?: bigint | undefined;
  }): Promise<unknown> {
    const ctx = this.buildRequestContext('FailRun', 'fail');
    const req = create(FailRunRequestSchema, {
      ctx,
      expectedVersion: params.expectedVersion ?? 0n,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    });
    return this.callIdempotent(() => this.authority.failRun(req as never));
  }

  /** releaseRunLease → ReleaseRunLease. Idempotent per epoch. */
  async releaseRunLease(leaseEpoch: bigint): Promise<unknown> {
    const ctx = this.buildRequestContext('ReleaseRunLease', `release:${leaseEpoch}`);
    const req = create(ReleaseRunLeaseRequestSchema, { ctx, leaseEpoch });
    return this.callIdempotent(() => this.authority.releaseRunLease(req as never));
  }
}

function toTimestamp(d: Date): { seconds: bigint; nanos: number } {
  const ms = d.getTime();
  return { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}
