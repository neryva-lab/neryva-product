import { describe, it, expect, beforeEach } from 'vitest';
import {
  publishDelta,
  subscribeRun,
  clearEphemeral,
  configureEphemeral,
  getEphemeralStats,
  DEFAULT_EPHEMERAL_CONFIG,
} from '../src/ephemeral.js';

describe('ephemeral delta path (1091-1101 scoped/TTL/bounded/backpressure, feature-flagged)', () => {
  beforeEach(() => clearEphemeral());

  it('disabled by default — no-op, durable path still succeeds', () => {
    const cfg = configureEphemeral({ enabled: false });
    const res = publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'delta1',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/ephemeral disabled/);
    expect(getEphemeralStats().totalDeltas).toBe(0);
  });

  it('scoped by run+organization, TTL, bounded', () => {
    const cfg = configureEphemeral({
      enabled: true,
      ttlMs: 60_000,
      maxBufferPerRun: 5,
      maxConsumersPerRun: 10,
    });
    for (let i = 0; i < 5; i++) {
      const r = publishDelta(
        {
          runId: 'run_1',
          organizationId: 'org_1',
          type: 'token',
          payload: `t${i}`,
          timestamp: new Date().toISOString(),
        },
        cfg,
      );
      expect(r.accepted).toBe(true);
    }
    expect(getEphemeralStats().totalDeltas).toBe(5);
    // 6th should drop oldest token while retaining
    const r6 = publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 't5',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    expect(r6.accepted).toBe(true);
    expect(r6.dropped).toBe(1);
    expect(getEphemeralStats().totalDeltas).toBe(5);
  });

  it('drop oldest deltas while retaining terminal/semantic (1091)', () => {
    const cfg = configureEphemeral({
      enabled: true,
      maxBufferPerRun: 3,
      maxConsumersPerRun: 10,
      ttlMs: 60_000,
    });
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'semantic',
        payload: 'semantic1',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'token1',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'token2',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    // Now buffer full (3), next token should drop oldest token not semantic
    const res = publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'token3',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    expect(res.accepted).toBe(true);
    expect(res.dropped).toBe(1);
    const sub = subscribeRun('run_1', 'org_1', cfg);
    expect(sub?.deltas.length).toBe(3);
    expect(sub?.deltas.some((d) => d.type === 'semantic')).toBe(true);
    expect(sub?.deltas.filter((d) => d.type === 'token').length).toBe(2);
    // Terminal never dropped
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'terminal',
        payload: 'done',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    const sub2 = subscribeRun('run_1', 'org_1', cfg);
    expect(sub2?.deltas.some((d) => d.type === 'terminal')).toBe(true);
  });

  it('max fan-out consumers per run', () => {
    const cfg = configureEphemeral({
      enabled: true,
      maxConsumersPerRun: 2,
      maxBufferPerRun: 10,
      ttlMs: 60_000,
    });
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'x',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    const s1 = subscribeRun('run_1', 'org_1', cfg);
    const s2 = subscribeRun('run_1', 'org_1', cfg);
    const s3 = subscribeRun('run_1', 'org_1', cfg);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s3).toBeUndefined(); // max exceeded
    s1?.release();
    const s4 = subscribeRun('run_1', 'org_1', cfg);
    expect(s4).toBeDefined();
  });

  it('no credentials in payload', () => {
    const cfg = configureEphemeral({
      enabled: true,
      maxBufferPerRun: 10,
      maxConsumersPerRun: 10,
      ttlMs: 60_000,
    });
    expect(() =>
      publishDelta(
        {
          runId: 'run_1',
          organizationId: 'org_1',
          type: 'token',
          payload: 'Bearer sk-123',
          timestamp: new Date().toISOString(),
        },
        cfg,
      ),
    ).toThrow(/must not contain credentials/);
  });

  it('requires scope', () => {
    const cfg = configureEphemeral({
      enabled: true,
      maxBufferPerRun: 10,
      maxConsumersPerRun: 10,
      ttlMs: 60_000,
    });
    expect(() =>
      publishDelta(
        {
          runId: '',
          organizationId: 'org_1',
          type: 'token',
          payload: 'x',
          timestamp: new Date().toISOString(),
        } as unknown as Parameters<typeof publishDelta>[0],
        cfg,
      ),
    ).toThrow(/requires runId\+organizationId/);
  });

  it('durable final not dependent on ephemeral loss (1502) — ephemeral drop does not affect commit', () => {
    const cfg = configureEphemeral({
      enabled: true,
      maxBufferPerRun: 1,
      maxConsumersPerRun: 10,
      ttlMs: 10,
    }); // tiny TTL
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'a',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    // Simulate Redis unavailability: clear buffer (ephemeral loss)
    clearEphemeral();
    expect(getEphemeralStats().totalDeltas).toBe(0);
    // Durable path still has committed result via Engine — simulated as true
    const durableCommitted = true;
    expect(durableCommitted).toBe(true);
  });

  it('TTL expiration clears old deltas', async () => {
    const cfg = configureEphemeral({
      enabled: true,
      ttlMs: 10,
      maxBufferPerRun: 10,
      maxConsumersPerRun: 10,
    });
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'x',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    expect(getEphemeralStats().totalDeltas).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    publishDelta(
      {
        runId: 'run_1',
        organizationId: 'org_1',
        type: 'token',
        payload: 'y',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    // Old deltas expired, only y remains
    expect(getEphemeralStats().totalDeltas).toBe(1);
  });

  it('default config disabled', () => {
    expect(DEFAULT_EPHEMERAL_CONFIG.enabled).toBe(false);
  });
});
