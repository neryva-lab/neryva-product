/**
 * versioning.test.ts — workflow version markers keep old paths until executions finish
 * Source: agent_studio_implementation_plan.md:850-853
 */

import { describe, it, expect } from 'vitest';
import {
  PATCH_IDS,
  WORKFLOW_VERSIONS,
  CURRENT_WORKFLOW_VERSION,
} from '../src/workflow-versioning.js';

describe('workflow versioning', () => {
  it('patch ids are unique and stable', () => {
    const ids = Object.values(PATCH_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('continue-as-new-v2');
    expect(ids).toContain('approval-signal-v2');
  });

  it('current version is initial for Phase 3', () => {
    expect(CURRENT_WORKFLOW_VERSION).toBe(WORKFLOW_VERSIONS.INITIAL);
    expect(CURRENT_WORKFLOW_VERSION).toBe('agent-run-v1');
  });
});
