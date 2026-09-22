/**
 * fixtures.ts — deterministic test fixtures with UUIDv7 opaque IDs
 * Source: neryva_mcp_implementation_plan.md:322-344, agent_studio_implementation_plan.md:1342
 * IDs are opaque, time-sortable (RFC 9562 UUIDv7), never used as secrets.
 * Do not use as auth decision; scope is via Engine capability, not timestamp.
 */

import { v7 as uuidv7 } from 'uuid';

export type OrganizationId = string;
export type ConversationId = string;
export type RunId = string;
export type MessageId = string;
export type AgentVersionId = string;
export type EventId = string;
export type ToolCallId = string;
export type ApprovalId = string;
export type ArtifactId = string;
export type RequestId = string;

export function newOrganizationId(): OrganizationId {
  return `org_${uuidv7()}`;
}

export function newConversationId(): ConversationId {
  return `conv_${uuidv7()}`;
}

export function newRunId(): RunId {
  return `run_${uuidv7()}`;
}

export function newMessageId(): MessageId {
  return `msg_${uuidv7()}`;
}

export function newAgentVersionId(): AgentVersionId {
  return `asst_v_${uuidv7()}`;
}

export function newEventId(): EventId {
  return `evt_${uuidv7()}`;
}

export function newToolCallId(): ToolCallId {
  return `tool_${uuidv7()}`;
}

export function newApprovalId(): ApprovalId {
  return `aprv_${uuidv7()}`;
}

export function newArtifactId(): ArtifactId {
  return `art_${uuidv7()}`;
}

export function newRequestId(): RequestId {
  return `req_${uuidv7()}`;
}

export interface RequestContextFixture {
  requestId: RequestId;
  organizationId: OrganizationId;
  conversationId: ConversationId;
  runId: RunId;
  agentVersionId: AgentVersionId;
  correlationId: string;
  protocolVersion: string;
  idempotencyKey: string;
}

export function createRequestContext(
  overrides: Partial<RequestContextFixture> = {},
): RequestContextFixture {
  return {
    requestId: newRequestId(),
    organizationId: newOrganizationId(),
    conversationId: newConversationId(),
    runId: newRunId(),
    agentVersionId: newAgentVersionId(),
    correlationId: uuidv7(),
    protocolVersion: '1.0',
    idempotencyKey: uuidv7(),
    ...overrides,
  };
}

export interface ArtifactRefFixture {
  artifactId: ArtifactId;
  organizationId: OrganizationId;
  runId: RunId;
  purpose: 'SOURCE_DOCUMENT' | 'CHECKPOINT' | 'TOOL_RESULT' | 'TRANSCRIPT' | 'EXPORT';
  mediaType: string;
  byteLength: number;
  sha256: Uint8Array; // exactly 32B
  expiresAt: Date;
}

export function createArtifactRef(overrides: Partial<ArtifactRefFixture> = {}): ArtifactRefFixture {
  const sha256 = new Uint8Array(32);
  crypto.getRandomValues(sha256);
  return {
    artifactId: newArtifactId(),
    organizationId: newOrganizationId(),
    runId: newRunId(),
    purpose: 'TOOL_RESULT',
    mediaType: 'application/octet-stream',
    byteLength: 1024,
    sha256,
    expiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}
