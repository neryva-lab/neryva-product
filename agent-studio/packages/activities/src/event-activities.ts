/**
 * event-activities.ts — durable semantic event emission (Engine is authoritative)
 * Source: agent_studio_implementation_plan.md:1057-1101 (durable via AppendRunEvents/CommitRunResult 1063-1076, emit after step outcome known, stable event_id/idempotencyKey, bounded else ArtifactRef 1080-1089),
 * 1501-1504 (frontend via Engine cursor, durable final not dependent on delta, trace correlation, redaction)
 * Ephemeral deltas via telemetry/ephemeral (optimization), durable via MCP (canonical).
 * Scope (organizationId/runId/correlationId) is passed per invocation — one worker serves many runs.
 */
import { heartbeat } from './heartbeat.js';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import { toUint64 } from './mcp-activities.js';
import {
  createRuntimeEvent,
  type RuntimeEvent,
  type EventType,
  type StudioArtifactRefLite,
} from '@neryva/contracts/events/runtime-events';
import { incrementCounter } from '@neryva/telemetry';
import { writeArtifact } from '@neryva/artifacts';

export interface EventActivitiesOptions {
  client: NeryvaMcpClient;
  /** Service identity that produces events — workload identity serviceName */
  producerId: string;
}

/** Per-run scope supplied by the workflow (from its bounded input) on every emission. */
export interface RunEventScope {
  organizationId: string;
  conversationId: string;
  runId: string;
  correlationId: string;
}

export function createEventActivities(opts: EventActivitiesOptions) {
  return {
    async emitEvent(params: {
      scope: RunEventScope;
      type: EventType;
      stepId?: string | undefined;
      body: RuntimeEvent['body'];
      artifactContent?: Uint8Array | undefined; // if large, will be artifact
      redaction?: RuntimeEvent['redaction'] | undefined;
    }): Promise<{
      eventId: string;
      idempotencyKey: string;
      wasArtifact: boolean;
    }> {
      heartbeat({ step: 'emitEvent', type: params.type });
      let artifactRef: StudioArtifactRefLite | undefined;
      let wasArtifact = false;
      if (params.artifactContent) {
        const bytes = params.artifactContent;
        // Bounded check: if >8192, must use artifact
        if (bytes.byteLength > 8192) {
          const ref = await writeArtifact(bytes, {
            organizationId: params.scope.organizationId,
            runId: params.scope.runId,
            purpose: 'TRANSCRIPT',
            mediaType: 'application/json',
          });
          artifactRef = {
            artifactId: ref.artifactId,
            organizationId: ref.organizationId,
            runId: ref.runId,
            purpose: ref.purpose,
            mediaType: ref.mediaType,
            byteLength: ref.byteLength,
            sha256: ref.sha256,
            expiresAt: ref.expiresAt,
            uri: ref.uri,
            encryptionKeyId: ref.encryptionKeyId,
          };
          wasArtifact = true;
        }
      }
      const event = createRuntimeEvent(
        {
          runId: params.scope.runId,
          organizationId: params.scope.organizationId,
          conversationId: params.scope.conversationId,
          stepId: params.stepId,
          type: params.type,
          producerId: opts.producerId,
          correlationId: params.scope.correlationId,
          redaction: params.redaction ?? 'NONE',
        },
        params.body,
        artifactRef,
      );
      // Emit after outcome known — idempotent append, retry only this path (1088)
      try {
        await opts.client.appendRunEvents([event]);
        incrementCounter('run_events_appended_total', { type: params.type, outcome: 'success' });
      } catch (e) {
        incrementCounter('run_events_appended_total', { type: params.type, outcome: 'error' });
        // Best-effort vs critical: terminal events are critical, others best-effort (don't block workflow)
        const isCritical =
          params.type === 'RunCompleted' ||
          params.type === 'RunFailed' ||
          params.type === 'RunStarted';
        if (isCritical) throw e;
        // For non-critical, swallow but log (workflow should not block forever on telemetry)
        return { eventId: event.eventId, idempotencyKey: event.idempotencyKey, wasArtifact };
      }
      // Engine sequence is authoritative — Studio-local sequence is diagnostic only (1088)
      return { eventId: event.eventId, idempotencyKey: event.idempotencyKey, wasArtifact };
    },

    async emitBatch(
      events: Array<
        Omit<
          RuntimeEvent,
          'eventId' | 'idempotencyKey' | 'producerTimestamp' | 'schemaVersion' | 'sequence'
        > & { scope: RunEventScope }
      >,
    ): Promise<void> {
      heartbeat({ step: 'emitBatch', count: events.length });
      if (events.length === 0 || events.length > 32) throw new Error('batch must be 1..32');
      // Full createRuntimeEvent for every batch member: stable idempotencyKey + eventId,
      // payload bound validated — never ad-hoc IDs.
      const mapped = events.map((e) =>
        createRuntimeEvent(
          {
            runId: e.scope.runId,
            organizationId: e.scope.organizationId,
            conversationId: e.scope.conversationId,
            stepId: e.stepId,
            type: e.type,
            producerId: opts.producerId,
            correlationId: e.scope.correlationId,
            redaction: e.redaction,
          },
          e.body,
          e.artifactRef,
        ),
      );
      await opts.client.appendRunEvents(mapped);
      incrementCounter(
        'run_events_appended_total',
        { type: 'batch', outcome: 'success' },
        mapped.length,
      );
    },

    async commitRunResult(
      scope: RunEventScope,
      resultText: string,
      expectedVersion?: number | bigint | undefined,
    ): Promise<unknown> {
      heartbeat({ step: 'commitRunResult', byteLength: resultText.length });
      // Final message durable via Engine; token deltas ephemeral (main.md:304)
      void scope;
      return opts.client.commitRunResult({
        resultText,
        expectedVersion: toUint64(expectedVersion, 'expectedVersion'),
      });
    },
  };
}

export type EventActivities = ReturnType<typeof createEventActivities>;
