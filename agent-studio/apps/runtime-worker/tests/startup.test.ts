import { describe, it, expect } from 'vitest';
import { createWorker } from '../src/worker.js';
import { parseEnv } from '../src/config.js';

describe('worker startup', () => {
  it('fails closed on missing Temporal', async () => {
    expect(() =>
      parseEnv({
        NERYVA_MCP_ENDPOINT: 'http://localhost:50051',
        TEMPORAL_ADDRESS: '',
        TEMPORAL_NAMESPACE: '',
      } as any),
    ).toThrow(/TEMPORAL_ADDRESS/);
  });

  it('creates worker with valid config', async () => {
    const cfg = parseEnv({
      TEMPORAL_ADDRESS: 'localhost:7233',
      TEMPORAL_NAMESPACE: 'default',
      NERYVA_MCP_ENDPOINT: 'http://localhost:50051',
    } as any);
    const worker = await createWorker(cfg);
    expect(worker).toBeDefined();
    expect(typeof worker.run).toBe('function');
  });
});
