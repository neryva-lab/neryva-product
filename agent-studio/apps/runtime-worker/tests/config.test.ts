import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config.js';

describe('config fail-closed', () => {
  it('fails when TEMPORAL_ADDRESS missing', () => {
    expect(() => parseEnv({ NERYVA_MCP_ENDPOINT: 'http://localhost:50051' } as any)).toThrow();
  });
  it('fails when NERYVA_MCP_ENDPOINT invalid', () => {
    expect(() =>
      parseEnv({
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_NAMESPACE: 'default',
        NERYVA_MCP_ENDPOINT: 'not-a-url',
      } as any),
    ).toThrow();
  });
  it('fails with unsafe content-capture in production', () => {
    expect(() =>
      parseEnv({
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_NAMESPACE: 'default',
        NERYVA_MCP_ENDPOINT: 'http://localhost:50051',
        ENVIRONMENT: 'production',
        OTEL_CONTENT_CAPTURE_POLICY: 'full',
      } as any),
    ).toThrow(/unsafe/);
  });
  it('parses valid minimal config', () => {
    const cfg = parseEnv({
      TEMPORAL_ADDRESS: 'localhost:7233',
      TEMPORAL_NAMESPACE: 'default',
      NERYVA_MCP_ENDPOINT: 'http://localhost:50051',
    } as any);
    expect(cfg.temporal.address).toBe('localhost:7233');
  });
});
