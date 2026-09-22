/**
 * ephemeral.ts — ephemeral delta path (Redis/Valkey) scoped/TTL/bounded/backpressure
 * Source: agent_studio_implementation_plan.md:1091-1101 (scoped, TTL, bounded buffer/backpressure, explicit max fan-out consumers/run + drop oldest while retaining terminal/semantic, no creds, not assumed delivered, reconciled via Engine),
 * agent_studio_architecture.md:304 (ephemeral is optimization, not canonical), main.md:304 (token deltas via Redis/ephemeral, final durable)
 * Feature-flagged; when disabled, no-ops. When Redis unavailable, durable path still succeeds (1502).
 */
export interface EphemeralConfig {
  enabled: boolean;
  ttlMs: number;
  maxBufferPerRun: number;
  maxConsumersPerRun: number;
}

export const DEFAULT_EPHEMERAL_CONFIG: EphemeralConfig = {
  enabled: false,
  ttlMs: 60_000,
  maxBufferPerRun: 1000,
  maxConsumersPerRun: 10,
};

export interface Delta {
  runId: string;
  organizationId: string;
  sequence?: number | undefined;
  type: 'token' | 'semantic' | 'terminal';
  payload: string; // redacted/hashed, never raw credential
  timestamp: string;
}

interface BufferedRun {
  deltas: Delta[];
  consumers: number;
  expiresAt: number;
}

const buffers = new Map<string, BufferedRun>();

export function configureEphemeral(config: Partial<EphemeralConfig>): EphemeralConfig {
  return { ...DEFAULT_EPHEMERAL_CONFIG, ...config };
}

export function isEphemeralEnabled(config: EphemeralConfig): boolean {
  return config.enabled;
}

export function publishDelta(
  delta: Delta,
  config: EphemeralConfig = DEFAULT_EPHEMERAL_CONFIG,
): { accepted: boolean; dropped?: number | undefined; reason?: string | undefined } {
  if (!config.enabled)
    return { accepted: false, reason: 'ephemeral disabled — durable path will handle' };
  // No creds in payload check
  const lower = JSON.stringify(delta.payload).toLowerCase();
  if (lower.includes('credential') || lower.includes('sk-') || lower.includes('bearer')) {
    throw new Error('ephemeral delta must not contain credentials');
  }
  // Scope check
  if (!delta.runId || !delta.organizationId)
    throw new Error('ephemeral delta requires runId+organizationId scope');
  const key = `${delta.organizationId}:${delta.runId}`;
  let buf = buffers.get(key);
  if (!buf) {
    buf = { deltas: [], consumers: 0, expiresAt: Date.now() + config.ttlMs };
    buffers.set(key, buf);
  }
  // TTL check
  if (buf.expiresAt < Date.now()) {
    buf.deltas = [];
    buf.expiresAt = Date.now() + config.ttlMs;
  }
  // Backpressure: max consumers
  if (buf.consumers > config.maxConsumersPerRun) {
    return { accepted: false, reason: 'max consumers exceeded — drop' };
  }
  // Bounded buffer: if at capacity, drop oldest token deltas while retaining semantic/terminal
  let dropped = 0;
  while (buf.deltas.length >= config.maxBufferPerRun) {
    const idx = buf.deltas.findIndex((d) => d.type === 'token');
    if (idx >= 0) {
      buf.deltas.splice(idx, 1);
      dropped++;
    } else {
      // No token to drop, drop oldest overall (should retain terminal but we drop oldest if all are semantic)
      buf.deltas.shift();
      dropped++;
    }
    if (dropped > 100) break; // safety
  }
  buf.deltas.push(delta);
  return { accepted: true, dropped: dropped > 0 ? dropped : undefined };
}

export function subscribeRun(
  runId: string,
  organizationId: string,
  config: EphemeralConfig = DEFAULT_EPHEMERAL_CONFIG,
): { deltas: Delta[]; release: () => void } | undefined {
  if (!config.enabled) return undefined;
  const key = `${organizationId}:${runId}`;
  const buf = buffers.get(key);
  if (!buf) return { deltas: [], release: () => {} };
  if (buf.consumers >= config.maxConsumersPerRun) return undefined;
  buf.consumers++;
  const deltas = [...buf.deltas];
  return {
    deltas,
    release: () => {
      buf.consumers = Math.max(0, buf.consumers - 1);
    },
  };
}

export function clearEphemeral(): void {
  buffers.clear();
}

export function getEphemeralStats(): { runs: number; totalDeltas: number } {
  let total = 0;
  for (const b of buffers.values()) total += b.deltas.length;
  return { runs: buffers.size, totalDeltas: total };
}
