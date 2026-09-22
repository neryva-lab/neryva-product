/**
 * NATS JetStream — optional durable fan-out after Engine commit — robust Phase 4 patch.
 * Reference: neryva_mcp_implementation_plan.md:540-552 + 556-566
 *
 * Rules:
 * - Engine DB commit FIRST, publish by outbox (best-effort). NATS outage must NOT invalidate committed state.
 * - Consumers process at-least-once, dedup by (run_id,event_id) + Nats-Msg-Id (`runId:eventId`).
 * - Duplicate suppression via `Nats-Msg-Id` on stream (duplicate publish returns original).
 * - Slow consumers isolated/bounded (maxPending, never blocks Engine commit).
 * - Stream is NOT the canonical ledger — Engine DB is.
 *
 * For Phase 4 spike: in-memory simulation with same semantics.
 */

import { RunEvent } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js";

export interface NatsMessage {
  id: string; // Nats-Msg-Id = `${runId}:${eventId}`
  subject: string;
  data: RunEvent;
  acked: boolean;
  timestamp: Date;
}

export interface NatsConsumer {
  id: string;
  pending: NatsMessage[];
  maxPending: number;
  dedup: Set<string>;
  subjectFilter?: string; // if set, only this subject; otherwise all
}

const streams = new Map<string, NatsMessage[]>();
const consumers = new Map<string, NatsConsumer>();
let _available = true;

export function setNatsAvailable(v: boolean): void {
  _available = v;
}
export function isNatsAvailable(): boolean {
  return _available;
}

/** Publish best-effort after commit. Never throws to caller — Engine already committed. */
export function publish(subject: string, event: RunEvent): NatsMessage | undefined {
  if (!_available) return undefined; // outage: drop, Engine commit already durable — caller must not fail
  const id = `${event.runId}:${event.eventId}`;
  const list = streams.get(subject) ?? [];
  // Duplicate suppression via Nats-Msg-Id (stream dedup)
  const existing = list.find((m) => m.id === id);
  if (existing) return existing;
  const msg: NatsMessage = { id, subject, data: event, acked: false, timestamp: new Date() };
  list.push(msg);
  streams.set(subject, list);
  // Fan-out to consumers (non-blocking, bounded)
  for (const consumer of consumers.values()) {
    if (consumer.subjectFilter && consumer.subjectFilter !== subject) continue;
    if (consumer.pending.length >= consumer.maxPending) {
      // Slow consumer — isolate: do not push, do not block. Consumer will replay via cursor anyway.
      continue;
    }
    if (consumer.dedup.has(id)) continue;
    consumer.pending.push(msg);
  }
  return msg;
}

/** Publish batch (best-effort). Returns count published. */
export function publishBatch(subject: string, events: RunEvent[]): number {
  let n = 0;
  for (const ev of events) if (publish(subject, ev)) n++;
  return n;
}

export function createConsumer(id: string, maxPending = 100, subjectFilter?: string): NatsConsumer {
  const c: NatsConsumer = { id, pending: [], maxPending, dedup: new Set(), subjectFilter };
  // Replay existing backlog that matches filter and not yet deduped (cursor resume without replaying model calls)
  if (subjectFilter) {
    const backlog = streams.get(subjectFilter) ?? [];
    for (const m of backlog) {
      if (c.pending.length >= c.maxPending) break;
      if (!c.dedup.has(m.id)) c.pending.push(m);
    }
  } else {
    for (const [, msgs] of streams) {
      for (const m of msgs) {
        if (c.pending.length >= c.maxPending) break;
        if (!c.dedup.has(m.id)) c.pending.push(m);
      }
    }
  }
  consumers.set(id, c);
  return c;
}

export function consume(consumerId: string): NatsMessage | undefined {
  const c = consumers.get(consumerId);
  if (!c || c.pending.length === 0) return undefined;
  return c.pending.shift()!;
}

export function ack(consumerId: string, msgId: string): void {
  const c = consumers.get(consumerId);
  if (!c) return;
  c.dedup.add(msgId);
  // Mark acked on any stream (subject-agnostic)
  for (const [, list] of streams) {
    const msg = list.find((m) => m.id === msgId);
    if (msg) {
      msg.acked = true;
      break;
    }
  }
}

/** NAK / redelivery: put back to front for retry (idempotent handler will dedup by event_id). */
export function nak(consumerId: string, msg: NatsMessage): void {
  const c = consumers.get(consumerId);
  if (!c) return;
  if (c.pending.length < c.maxPending) c.pending.unshift(msg);
}

export function getStream(subject: string): NatsMessage[] {
  return streams.get(subject) ?? [];
}

export function getConsumerLag(consumerId: string): number {
  return consumers.get(consumerId)?.pending.length ?? 0;
}

export function clearNats(): void {
  streams.clear();
  consumers.clear();
  _available = true;
}
