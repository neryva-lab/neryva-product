/**
 * runtime-events.ts — durable semantic events (Engine is system of record)
 * Source: agent_studio_implementation_plan.md:1057-1101 (durable semantic events + ephemeral streaming),
 * 1063-1076 (RunStarted, ContextPrepared, ModelCallStarted/Completed, ToolCallProposed/Approved/Completed, ApprovalRequested/Received, MemoryProposed, RunWarning, RunCompleted/RunFailed),
 * 1080-1089 (stable logical event key, emit after outcome, bound size, Engine sequence authoritative, retry only idempotent appends),
 * contracts: neryva.mcp.event.v1.RunEvent (event_id, run_id, step_id, type, schema_version, producer, timestamps, redaction, body oneof)
 * Token deltas ephemeral (1078); final + milestones durable via Engine AppendRunEvents/CommitRunResult.
 */

export interface StudioArtifactRefLite {
  artifactId: string;
  organizationId: string;
  runId: string;
  purpose: string;
  mediaType: string;
  byteLength: number;
  sha256: Uint8Array;
  expiresAt: Date;
  uri?: string | undefined;
  encryptionKeyId?: string | undefined;
}

export const RUNTIME_EVENT_SCHEMA_VERSION = '1.0';

export type EventType =
  | 'RunStarted'
  | 'AssistantChunk'
  | 'AssistantThinking'
  | 'ContextPrepared'
  | 'ModelCallStarted'
  | 'ModelCallCompleted'
  | 'ToolCallProposed'
  | 'ToolCallApproved'
  | 'ToolCallCompleted'
  | 'ApprovalRequested'
  | 'ApprovalReceived'
  | 'MemoryProposed'
  | 'MediaGenerated'
  | 'RunWarning'
  | 'RunCompleted'
  | 'RunFailed';

export const EVENT_TYPES: readonly EventType[] = [
  'RunStarted',
  'AssistantChunk',
  'ContextPrepared',
  'ModelCallStarted',
  'ModelCallCompleted',
  'ToolCallProposed',
  'ToolCallApproved',
  'ToolCallCompleted',
  'ApprovalRequested',
  'ApprovalReceived',
  'MemoryProposed',
  'MediaGenerated',
  'RunWarning',
  'RunCompleted',
  'RunFailed',
] as const;

export type RedactionClass = 'NONE' | 'PII' | 'SECRET';

export interface RuntimeEventBase {
  eventId: string; // stable logical key
  runId: string;
  organizationId: string;
  conversationId: string;
  stepId?: string | undefined;
  type: EventType;
  schemaVersion: string;
  producerId: string;
  producerSequence?: number | undefined; // untrusted diagnostic
  expectedRunVersion?: number | undefined; // CAS
  producerTimestamp: string; // ISO
  correlationId: string;
  idempotencyKey: string; // stable run+step+type for dedup
  redaction: RedactionClass;
  sequence?: number | undefined; // Engine-assigned authoritative
}

export type RuntimeEventBody =
  | { kind: 'RunStarted'; runId: string; agentVersionId: string }
  | { kind: 'AssistantChunk'; runId: string; text: string; isFinal: boolean }
  | { kind: 'ContextPrepared'; runId: string; citationCount: number; budgetDiagnostics?: unknown }
  | { kind: 'ModelCallStarted'; runId: string; modelId: string; stepId: string }
  | { kind: 'AssistantThinking'; runId: string; text: string; isFinal: boolean }
  | {
      kind: 'ModelCallCompleted';
      runId: string;
      modelId: string;
      stepId: string;
      usage?: unknown;
      artifactRef?: StudioArtifactRefLite | undefined;
      textPreviewHash?: string | undefined;
    }
  | {
      kind: 'ToolCallProposed';
      runId: string;
      toolName: string;
      toolCallId: string;
      stepId: string;
      /**
       * A3-21 — sanitized argument summary JSON: the redacted argument object
       * (sensitive fields replaced via @neryva/security redactObject), or a
       * {"withheld": "..."} marker when the arguments cannot be safely
       * summarized. Never raw secrets or credentials. Surfaced on the wire as
       * ToolCallBody.arguments so the chat tool-call card can render it.
       */
      argumentSummary: string;
    }
  | {
      kind: 'ToolCallApproved';
      runId: string;
      toolName: string;
      toolCallId: string;
      approvalId: string;
    }
  | {
      kind: 'ToolCallCompleted';
      runId: string;
      toolName: string;
      toolCallId: string;
      stepId: string;
      artifactRef?: StudioArtifactRefLite | undefined;
      success: boolean;
    }
  | { kind: 'ApprovalRequested'; runId: string; approvalId: string; toolCallId: string }
  | { kind: 'ApprovalReceived'; runId: string; approvalId: string; decision: string }
  | { kind: 'MemoryProposed'; runId: string; proposalId: string; scope: string }
  | { kind: 'MediaGenerated'; runId: string; artifactId: string; mediaType: string }
  | { kind: 'RunWarning'; runId: string; code: string; messageHash: string }
  | { kind: 'RunCompleted'; runId: string; resultType: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' }
  | { kind: 'RunFailed'; runId: string; errorCode: string; errorMessageHash: string };

export interface RuntimeEvent extends RuntimeEventBase {
  body: RuntimeEventBody;
  artifactRef?: StudioArtifactRefLite | undefined; // for large payloads
}

export const MAX_EVENT_PAYLOAD_BYTES = 8192;
export const MAX_EVENT_BATCH = 32;

export function deriveIdempotencyKey(
  runId: string,
  type: EventType,
  stepId?: string | undefined,
  logical?: string | undefined,
): string {
  const parts = [runId, type, stepId ?? 'none', logical ?? '0'].join(':');
  return parts;
}

export function deriveEventId(runId: string, idempotencyKey: string): string {
  // Stable deterministic eventId from the idempotency key — retries of the same logical
  // event MUST produce the same eventId or Engine-side dedup breaks. No wall-clock input.
  let hash = 0;
  for (let i = 0; i < idempotencyKey.length; i++)
    hash = (hash * 31 + idempotencyKey.charCodeAt(i)) >>> 0;
  return `evt_${runId.slice(0, 8)}_${hash.toString(36)}`;
}

export function validateRuntimeEvent(event: RuntimeEvent): void {
  if (!event.eventId || typeof event.eventId !== 'string') throw new Error('eventId required');
  if (!event.runId) throw new Error('runId required');
  if (!event.organizationId) throw new Error('organizationId required');
  if (!event.conversationId) throw new Error('conversationId required');
  if (!EVENT_TYPES.includes(event.type)) throw new Error(`unknown event type ${event.type}`);
  if (!event.schemaVersion) throw new Error('schemaVersion required');
  if (!event.producerId) throw new Error('producerId required');
  if (!event.correlationId) throw new Error('correlationId required');
  if (!event.idempotencyKey) throw new Error('idempotencyKey required');
  const payloadJson = JSON.stringify(event.body);
  const byteLength = new TextEncoder().encode(payloadJson).byteLength;
  if (byteLength > MAX_EVENT_PAYLOAD_BYTES && !event.artifactRef) {
    throw new Error(
      `event payload ${byteLength} exceeds ${MAX_EVENT_PAYLOAD_BYTES} — must use artifactRef`,
    );
  }
}

export function createRuntimeEvent(
  base: Omit<
    RuntimeEventBase,
    'eventId' | 'idempotencyKey' | 'producerTimestamp' | 'schemaVersion' | 'redaction'
  > & { redaction?: RedactionClass | undefined; idempotencyLogical?: string | undefined },
  body: RuntimeEventBody,
  artifactRef?: StudioArtifactRefLite | undefined,
): RuntimeEvent {
  const idempotencyKey = deriveIdempotencyKey(
    base.runId,
    base.type,
    base.stepId,
    base.idempotencyLogical,
  );
  const eventId = deriveEventId(base.runId, idempotencyKey);
  const event: RuntimeEvent = {
    eventId,
    runId: base.runId,
    organizationId: base.organizationId,
    conversationId: base.conversationId,
    stepId: base.stepId,
    type: base.type,
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    producerId: base.producerId,
    producerSequence: base.producerSequence,
    expectedRunVersion: base.expectedRunVersion,
    producerTimestamp: new Date().toISOString(),
    correlationId: base.correlationId,
    idempotencyKey,
    redaction: base.redaction ?? 'NONE',
    sequence: base.sequence,
    body,
    artifactRef,
  };
  validateRuntimeEvent(event);
  return event;
}

export function toMcpAppendBatch(events: RuntimeEvent[]): unknown[] {
  if (events.length === 0 || events.length > MAX_EVENT_BATCH)
    throw new Error(`event batch must be 1..${MAX_EVENT_BATCH}, got ${events.length}`);
  // Map to neryva.mcp.event.v1.RunEvent shape (minimal for fake transport)
  return events.map((e) => ({
    eventId: e.eventId,
    runId: e.runId,
    stepId: e.stepId ?? '',
    type: e.type,
    schemaVersion: e.schemaVersion,
    producerId: e.producerId,
    producerSequence: e.producerSequence ?? 0,
    expectedRunVersion: e.expectedRunVersion ?? 0,
    producerTimestamp: e.producerTimestamp,
    correlationId: e.correlationId,
    idempotencyKey: e.idempotencyKey,
    redaction: e.redaction,
    body: e.body,
    artifactRef: e.artifactRef,
  }));
}
