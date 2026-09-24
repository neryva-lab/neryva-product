/**
 * event-mapper.ts — map domain RuntimeEvents to generated neryva.mcp.event.v1.RunEvent
 * Source: contracts/events/runtime-events.ts, neryva.mcp.event.v1 proto
 * The mapping lives at the protocol boundary (this package) so @neryva/contracts stays
 * dependency-free. Generated types only — never hand-copied message shapes.
 */

import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { RunEventSchema } from '@neryva/mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js';
import type { RunEvent } from '@neryva/mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js';
import { ArtifactRefSchema } from '@neryva/mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js';
import {
  EventType,
  RedactionClass,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js';
import type { RuntimeEvent } from '@neryva/contracts/events/runtime-events';

function toTimestamp(d: Date): { seconds: bigint; nanos: number } {
  const ms = d.getTime();
  return { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

function redactionToProto(r: RuntimeEvent['redaction']): RedactionClass {
  switch (r) {
    case 'PII':
      return RedactionClass.PII;
    case 'SECRET':
      return RedactionClass.SECRET;
    default:
      return RedactionClass.NONE;
  }
}

function toArtifactRef(ref: NonNullable<RuntimeEvent['artifactRef']>) {
  return create(ArtifactRefSchema, {
    artifactId: ref.artifactId,
    uri: ref.uri ?? '',
    mediaType: ref.mediaType,
    byteLength: BigInt(ref.byteLength),
    sha256: ref.sha256,
    encryptionKeyId: ref.encryptionKeyId ?? '',
    purpose: ref.purpose,
    expiresAt: toTimestamp(ref.expiresAt),
  });
}

/** Map one domain RuntimeEvent to the generated RunEvent message. Deterministic. */
export function toMcpRunEvent(e: RuntimeEvent): RunEvent {
  const base = {
    eventId: e.eventId,
    runId: e.runId,
    stepId: e.stepId ?? '',
    schemaVersion: e.schemaVersion,
    producerId: e.producerId,
    producerSequence: BigInt(e.producerSequence ?? 0),
    expectedRunVersion: BigInt(e.expectedRunVersion ?? 0),
    producerTimestamp: toTimestamp(new Date(e.producerTimestamp)),
    redaction: redactionToProto(e.redaction),
  };

  switch (e.body.kind) {
    case 'RunStarted':
      return create(RunEventSchema, {
        ...base,
        type: EventType.RUN_LIFECYCLE,
        body: {
          case: 'lifecycle',
          value: { fromState: '', toState: 'RUNNING', reason: 'run_started' },
        },
      });
    case 'ContextPrepared':
      return create(RunEventSchema, {
        ...base,
        type: EventType.RUN_LIFECYCLE,
        body: {
          case: 'lifecycle',
          value: {
            fromState: 'LOAD_CONTEXT',
            toState: 'CONTEXT_LOADED',
            reason: `citations:${e.body.citationCount}`,
          },
        },
      });
    case 'AssistantChunk':
      return create(RunEventSchema, {
        ...base,
        type: EventType.ASSISTANT_CHUNK,
        body: {
          case: 'assistantChunk',
          value: { text: e.body.text, isFinal: e.body.isFinal },
        },
      });
    case 'RunWarning':
      return create(RunEventSchema, {
        ...base,
        type: EventType.RUN_LIFECYCLE,
        body: {
          case: 'lifecycle',
          value: {
            fromState: '',
            toState: '',
            reason: `warning:${e.body.code}:${e.body.messageHash}`,
          },
        },
      });
    case 'AssistantThinking':
      return create(RunEventSchema, {
        ...base,
        type: EventType.THINKING,
        body: { case: 'assistantChunk', value: { text: e.body.text, isFinal: e.body.isFinal } },
      });
    case 'ModelCallStarted':
    case 'ModelCallCompleted':
      return create(RunEventSchema, {
        ...base,
        type: EventType.ASSISTANT_CHUNK,
        body: {
          case: 'model',
          value: {
            modelId: e.body.modelId,
            providerRequestId: '',
            requestRef:
              e.body.kind === 'ModelCallCompleted' && e.body.artifactRef
                ? toArtifactRef(e.body.artifactRef)
                : undefined,
            responseRef: undefined,
          },
        },
      });
    case 'ToolCallProposed':
      return create(RunEventSchema, {
        ...base,
        type: EventType.TOOL_CALL,
        body: {
          case: 'toolCall',
          value: {
            toolCallId: e.body.toolCallId,
            toolName: e.body.toolName,
            // A3-21 — the digest is now REAL: sha256 over the sanitized
            // summary (previously an empty Uint8Array, violating the proto's
            // bytes.len = 32). The summary itself rides as `arguments` so
            // the console's parseRunEvent (value.arguments) can render it.
            argumentDigest: createHash('sha256')
              .update(e.body.argumentSummary, 'utf8')
              .digest(),
            arguments: e.body.argumentSummary,
          },
        },
      });
    case 'ToolCallCompleted':
      return create(RunEventSchema, {
        ...base,
        type: EventType.TOOL_RESULT,
        body: {
          case: 'toolResult',
          value: {
            toolCallId: e.body.toolCallId,
            resultDigest: new Uint8Array(),
            status: e.body.success ? 'SUCCEEDED' : 'FAILED',
          },
        },
      });
    case 'ApprovalRequested':
      return create(RunEventSchema, {
        ...base,
        type: EventType.APPROVAL,
        body: {
          case: 'approval',
          value: { approvalId: e.body.approvalId, state: 'PENDING', decisionId: '' },
        },
      });
    case 'ToolCallApproved':
      return create(RunEventSchema, {
        ...base,
        type: EventType.APPROVAL,
        body: {
          case: 'approval',
          value: { approvalId: e.body.approvalId, state: 'APPROVED', decisionId: '' },
        },
      });
    case 'ApprovalReceived':
      return create(RunEventSchema, {
        ...base,
        type: EventType.APPROVAL,
        body: {
          case: 'approval',
          value: { approvalId: e.body.approvalId, state: e.body.decision, decisionId: '' },
        },
      });
    case 'MediaGenerated':
      return create(RunEventSchema, {
        ...base,
        type: EventType.MEDIA,
        body: {
          case: 'media',
          value: { artifactId: e.body.artifactId, mediaType: e.body.mediaType },
        },
      });
    case 'MemoryProposed':
      return create(RunEventSchema, {
        ...base,
        type: EventType.MEMORY,
        body: {
          case: 'memory',
          value: { proposalId: e.body.proposalId, scope: e.body.scope, decision: 'PROPOSED' },
        },
      });
    case 'RunCompleted':
      return create(RunEventSchema, {
        ...base,
        type: EventType.TERMINAL,
        body: { case: 'terminal', value: { code: 'RUN_COMPLETED', message: e.body.resultType } },
      });
    case 'RunFailed':
      return create(RunEventSchema, {
        ...base,
        type: EventType.TERMINAL,
        body: {
          case: 'terminal',
          value: { code: e.body.errorCode, message: e.body.errorMessageHash },
        },
      });
  }
}
