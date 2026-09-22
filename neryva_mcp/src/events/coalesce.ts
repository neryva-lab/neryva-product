/**
 * Event coalescing — durable vs ephemeral — robust Phase 4 patch.
 * Reference: neryva_mcp_implementation_plan.md:495-514, 531-532
 *
 * Durable in Engine (persisted, authoritative, must survive reconnect):
 * - run lifecycle (state transitions)        → EVENT_TYPE_RUN_LIFECYCLE (1)
 * - tool proposed/authorized/started/completed/failed → TOOL_CALL (3), TOOL_RESULT (4)
 * - approval requested/decided/expired       → APPROVAL (6)
 * - memory proposed/accepted/rejected        → MEMORY (7)
 * - checkpoint saved/restored                → CHECKPOINT (8)
 * - usage and cost observations              → USAGE (10)
 * - terminal result or failure               → TERMINAL (11)
 * + citations/artifact metadata, audit, run_steps, final assistant message (separate tables)
 *
 * Ephemeral / coalesced by policy (NOT authoritative, may be dropped after terminal grace):
 * - every individual token delta              → ASSISTANT_CHUNK (2)  — coalesce per step
 * - retrieval / citation raw hits            → RETRIEVAL (5)       — coalesce or keep only cited
 * - policy/moderation/redaction raw          → POLICY (9)          — short-lived
 * - worker-local debug logs, transient provider bodies, intermediate prompts, repeated heartbeats
 *   Heartbeat is NOT a business event and never carries a sequence (handled out-of-band in WatchRunEvents).
 *
 * Engine may persist coalesced output snapshots for reconnect UX, but final assistant message remains authoritative.
 */

import { RunEvent } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js";

// Explicit per neryva_mcp_implementation_plan.md:509-522
const DURABLE_TYPES = new Set<number>([1, 3, 4, 6, 7, 8, 10, 11]);
const EPHEMERAL_TYPES = new Set<number>([2, 5, 9]);

export function isDurable(event: RunEvent): boolean {
  return DURABLE_TYPES.has(event.type);
}

export function isEphemeral(event: RunEvent): boolean {
  return EPHEMERAL_TYPES.has(event.type) || !DURABLE_TYPES.has(event.type);
}

export function shouldPersist(event: RunEvent): boolean {
  // Durable always persisted; ephemeral only if it's a coalesced snapshot marked isFinal
  if (isDurable(event)) return true;
  if (event.type === 2 && event.body.case === "assistantChunk") {
    return Boolean((event.body.value as { isFinal: boolean }).isFinal);
  }
  return false;
}

/**
 * Coalesce ephemeral token deltas into a single snapshot for persistence / reconnect.
 * Joins all ASSISTANT_CHUNK texts for the same step (or across steps if stepId not filtered).
 * Preserves last event's sequence/ids but merges text; isFinal = any chunk is final.
 * If chunks use ArtifactBody (coalescedRef) already, prefer that ref.
 */
export function coalesceAssistantChunks(events: RunEvent[]): RunEvent | undefined {
  const chunks = events.filter((e) => e.type === 2 && e.body.case === "assistantChunk");
  if (chunks.length === 0) return undefined;
  const last = chunks[chunks.length - 1];
  // If any chunk already has coalescedRef, keep it (claim-check path)
  const hasRef = chunks.some((c) => Boolean((c.body.value as { coalescedRef?: unknown }).coalescedRef));
  if (hasRef) return last;
  const text = chunks.map((c) => (c.body.value as { text: string }).text ?? "").join("");
  const isFinal = chunks.some((c) => (c.body.value as { isFinal: boolean }).isFinal);
  return {
    ...last,
    body: { case: "assistantChunk", value: { text, isFinal, coalescedRef: undefined } },
  } as RunEvent;
}

/**
 * For observation: partition into durable (authoritative) vs ephemeral (coalesced/short-lived).
 * Heartbeats are never in this list.
 */
export function partitionEvents(events: RunEvent[]): { durable: RunEvent[]; ephemeral: RunEvent[] } {
  const durable: RunEvent[] = [];
  const ephemeral: RunEvent[] = [];
  for (const e of events) {
    if (isDurable(e)) durable.push(e);
    else ephemeral.push(e);
  }
  return { durable, ephemeral };
}

/** Filter to only events that should be returned to frontend after redaction (ephemeral coalesced snapshots are okay). */
export function filterForFrontend(events: RunEvent[]): RunEvent[] {
  // Drop ephemeral non-final deltas that were not coalesced — frontend only needs coalesced snapshot
  // For spike we keep all; real policy would drop intermediate deltas.
  return events;
}
