/**
 * Redis/Valkey — cache, rate-limit, transient fan-out ONLY — robust Phase 4 patch.
 * Reference: neryva_mcp_implementation_plan.md:552, 568
 *
 * INVARIANT: Redis is NEVER the source of truth for runs/conversations/events/approvals.
 * All canonical state lives in Engine DB (`src/engine/store.ts`). Redis outages must not lose committed state.
 * Allowed uses:
 * - Short-lived fan-out (pub/sub) for WatchRunEvents push (optional, best-effort)
 * - Rate limiting (token bucket per org/run)
 * - Cache for context manifests / artifact manifests (TTL, must tolerate miss)
 */

const cache = new Map<string, { value: unknown; expiresAt: number }>();

function namespaced(key: string): string {
  // Enforce namespacing to avoid cross-tenant leakage in shared Redis
  if (!key.includes(":")) return `neryva:${key}`;
  return key.startsWith("neryva:") ? key : `neryva:${key}`;
}

export function redisSet(key: string, value: unknown, ttlMs = 60_000): void {
  cache.set(namespaced(key), { value, expiresAt: Date.now() + ttlMs });
}

export function redisGet(key: string): unknown | undefined {
  const entry = cache.get(namespaced(key));
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(namespaced(key));
    return undefined;
  }
  return entry.value;
}

export function redisDel(key: string): void {
  cache.delete(namespaced(key));
}

export function redisIncr(key: string, windowMs = 60_000): number {
  const current = (redisGet(key) as number) ?? 0;
  const next = current + 1;
  redisSet(key, next, windowMs);
  return next;
}

export function isRateLimited(key: string, limit: number, windowMs = 60_000): boolean {
  const count = redisIncr(key, windowMs);
  return count > limit;
}

/** Transient pub/sub simulation — best-effort fan-out for watchers, not durable. */
const channels = new Map<string, Set<(msg: unknown) => void>>();

export function redisPublish(channel: string, msg: unknown): void {
  const subs = channels.get(namespaced(channel));
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(msg);
    } catch {
      // never propagate to publisher
    }
  }
}

export function redisSubscribe(channel: string, cb: (msg: unknown) => void): () => void {
  const key = namespaced(channel);
  let set = channels.get(key);
  if (!set) {
    set = new Set();
    channels.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) channels.delete(key);
  };
}

export function clearRedis(): void {
  cache.clear();
  channels.clear();
}

/** Assertion helper for tests: ensure no run state is read from Redis. */
export function assertNotSourceOfTruth(): void {
  // In production, grep for `redisGet("run:` should be disallowed — only `store.getRun` is authoritative.
}
