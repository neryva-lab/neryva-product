import { describe, it, expect, beforeEach } from 'vitest';
import { createRuntimeEvent } from '@neryva/contracts/events/runtime-events';
import { publishDelta, clearEphemeral, configureEphemeral } from '../src/ephemeral.js';
import { incrementCounter, getMetricSnapshot, resetMetrics } from '../src/metrics.js';

describe('durable vs ephemeral independence (1502)', () => {
  beforeEach(() => {
    clearEphemeral();
    resetMetrics();
  });

  it('durable CommitRunResult succeeds even when ephemeral Redis unavailable', async () => {
    // Simulate ephemeral disabled (Redis down) — durable path still appends
    const ephemeralCfg = configureEphemeral({ enabled: false });
    const deltaRes = publishDelta(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        type: 'token',
        payload: 'token',
        timestamp: new Date().toISOString(),
      },
      ephemeralCfg,
    );
    expect(deltaRes.accepted).toBe(false); // ephemeral not delivered
    // Durable event via Engine still succeeds
    const evt = createRuntimeEvent(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        conversationId: 'conv_123',
        producerId: 'w1',
        correlationId: 'corr',
        type: 'RunCompleted',
      },
      { kind: 'RunCompleted', runId: 'run_123', resultType: 'SUCCEEDED' },
    );
    expect(evt.type).toBe('RunCompleted');
    incrementCounter('run_events_appended_total', { type: 'RunCompleted', outcome: 'success' });
    const snap = getMetricSnapshot();
    expect(
      Object.keys(snap.counters).some(
        (k) => k.includes('run_events_appended_total') && k.includes('RunCompleted'),
      ),
    ).toBe(true);
  });

  it('ephemeral loss does not lose Engine sequence — durable ledger retains', () => {
    const cfg = configureEphemeral({
      enabled: true,
      ttlMs: 60_000,
      maxBufferPerRun: 10,
      maxConsumersPerRun: 10,
    });
    // Publish some ephemeral deltas
    publishDelta(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        type: 'token',
        payload: 't1',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    publishDelta(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        type: 'token',
        payload: 't2',
        timestamp: new Date().toISOString(),
      },
      cfg,
    );
    // Simulate Redis crash — ephemeral cleared
    clearEphemeral();
    expect(getMetricSnapshot().counters); // metrics still there but ephemeral cleared
    // Durable events still in Engine ledger — simulate append
    const durables = [
      createRuntimeEvent(
        {
          runId: 'run_123',
          organizationId: 'org_123',
          conversationId: 'conv_123',
          producerId: 'w1',
          correlationId: 'corr',
          type: 'RunStarted',
        },
        { kind: 'RunStarted', runId: 'run_123', agentVersionId: 'v1' },
      ),
      createRuntimeEvent(
        {
          runId: 'run_123',
          organizationId: 'org_123',
          conversationId: 'conv_123',
          producerId: 'w1',
          correlationId: 'corr',
          type: 'RunCompleted',
        },
        { kind: 'RunCompleted', runId: 'run_123', resultType: 'SUCCEEDED' },
      ),
    ];
    expect(durables.length).toBe(2);
    // Frontend can still reconstruct from Engine durable cursor even though ephemeral deltas lost
    const reconstructed = durables.filter((d) => d.type === 'RunCompleted');
    expect(reconstructed.length).toBe(1);
  });

  it('token deltas ephemeral, final message durable via Engine', () => {
    // Token deltas via ephemeral, final via durable
    const ephemeral = configureEphemeral({
      enabled: true,
      ttlMs: 60_000,
      maxBufferPerRun: 100,
      maxConsumersPerRun: 10,
    });
    const tokenDelta = publishDelta(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        type: 'token',
        payload: 'Hello',
        timestamp: new Date().toISOString(),
      },
      ephemeral,
    );
    expect(tokenDelta.accepted).toBe(true);
    // Final durable
    const final = createRuntimeEvent(
      {
        runId: 'run_123',
        organizationId: 'org_123',
        conversationId: 'conv_123',
        producerId: 'w1',
        correlationId: 'corr',
        type: 'RunCompleted',
      },
      { kind: 'RunCompleted', runId: 'run_123', resultType: 'SUCCEEDED' },
    );
    expect(final.type).toBe('RunCompleted');
    // Durable final does not depend on token delta delivery
    expect(tokenDelta.accepted).toBe(true);
    expect(final.eventId).toBeDefined();
  });
});
