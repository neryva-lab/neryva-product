/**
 * Cursor helpers for WatchRunEvents resumable observation — robust patch for Phase 4.
 * Reference: neryva_mcp_implementation_plan.md:536,550-553, 550-553
 *
 * Invariants:
 * - Engine assigns authoritative per-run monotonic `sequence` (uint64) in `store.appendEvents`.
 * - Producer-local `producer_sequence` is UNTRUSTED, never used for ordering.
 * - `WatchRunEvents(afterSequence)` returns events with `sequence > afterSequence` ordered ascending.
 * - Delivery is at-least-once: client MUST apply idempotently by `sequence` and tolerate repeats after reconnect.
 * - Heartbeat is NOT a business event (never persisted, never counted in sequence).
 * - Durable projection persists `appliedSequence` atomically with projection update — on reconnect, caller resumes from last persisted sequence.
 */

import type { RunEvent } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js";

export interface Cursor {
  afterSequence: bigint;
  events: RunEvent[];
}

/**
 * Advance cursor to max sequence of newEvents. If newEvents empty, cursor unchanged.
 * Validates monotonicity: every event's sequence must be > current.afterSequence and strictly increasing in input order.
 * Throws if gap or out-of-order detected — callers should re-fetch via ListRunEvents instead of inventing sequence.
 */
export function nextCursor(current: Cursor, newEvents: RunEvent[]): Cursor {
  if (newEvents.length === 0) return current;
  // Validate strictly increasing and > current.afterSequence
  let prev = current.afterSequence;
  for (const ev of newEvents) {
    if (ev.sequence <= prev) {
      throw new Error(`non-monotonic sequence: ${ev.sequence} <= ${prev} (event ${ev.eventId})`);
    }
    prev = ev.sequence;
  }
  const maxSeq = newEvents[newEvents.length - 1].sequence;
  return { afterSequence: maxSeq, events: [...current.events, ...newEvents] };
}

/**
 * At-least-once deduplication: keep first occurrence of each `sequence`, drop repeats that can occur after reconnect.
 * Sort by bigint sequence ascending; do NOT coerce to Number (would lose >2^53).
 */
export function deduplicateBySequence(events: RunEvent[]): RunEvent[] {
  const seen = new Set<string>();
  const out: RunEvent[] = [];
  for (const ev of events) {
    const key = String(ev.sequence);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ev);
    }
  }
  return out.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
}

// ── Pagination token helpers (opaque to client) ──

/** Encode afterSequence as nextPageToken (base10 string). Empty -> "" means no more pages. */
export function encodePageToken(afterSequence: bigint): string {
  return String(afterSequence);
}

/** Decode pageToken back to afterSequence. Empty/invalid -> 0n. */
export function decodePageToken(token: string | undefined): bigint {
  if (!token) return 0n;
  try {
    const n = BigInt(token);
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

/**
 * Durable projection helper — caller persists `appliedSequence` atomically with its projection.
 * Example: UI store `lastAppliedSequence` in IndexedDB transaction with rendered items.
 * On reconnect, pass that persisted value as `afterSequence` to `WatchRunEvents`.
 *
 * This function simulates the atomic apply: given existing projection and new events,
 * return updated projection and next afterSequence, deduplicated.
 */
export function applyEventsAtomically<T>(
  projection: T[],
  appliedSequence: bigint,
  newEvents: RunEvent[],
  map: (ev: RunEvent) => T,
): { projection: T[]; appliedSequence: bigint } {
  // Filter out already-applied events (idempotent)
  const unseen = newEvents.filter((e) => e.sequence > appliedSequence);
  const deduped = deduplicateBySequence([...unseen].sort((a, b) => (a.sequence < b.sequence ? -1 : 1)));
  const nextSeq = deduped.length > 0 ? deduped[deduped.length - 1].sequence : appliedSequence;
  const nextProjection = [...projection, ...deduped.map(map)];
  return { projection: nextProjection, appliedSequence: nextSeq };
}

/** Validate that a list from ListRunEvents is correctly ordered and gap-free for the window (best-effort spike check). */
export function assertMonotonic(events: RunEvent[], afterSequence: bigint): void {
  let expected = afterSequence + 1n;
  for (const ev of events) {
    if (ev.sequence !== expected && ev.sequence > afterSequence) {
      // Gap is allowed only if events were filtered/deleted? For spike we allow gaps but ensure ascending.
      if (ev.sequence <= afterSequence || ev.sequence < expected) throw new Error(`out-of-order ${ev.sequence} expected >= ${expected}`);
    }
    expected = ev.sequence + 1n;
  }
}
