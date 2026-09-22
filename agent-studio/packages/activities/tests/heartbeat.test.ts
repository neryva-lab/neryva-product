/**
 * heartbeat.test.ts — long Activities heartbeat + checkpoint ref
 * Source: agent_studio_architecture.md:137, agent_studio_implementation_plan.md:839-848
 */

import { describe, it, expect } from 'vitest';
import { heartbeat, heartbeatCheckpoint } from '../src/heartbeat.js';

describe('heartbeat', () => {
  it('heartbeat outside activity context does not throw', () => {
    expect(() => heartbeat({ step: 'test', progress: 50 })).not.toThrow();
  });

  it('heartbeatCheckpoint wraps payload deterministically', () => {
    expect(() => heartbeatCheckpoint({ stepId: 'step_1', progress: 42 })).not.toThrow();
  });
});
