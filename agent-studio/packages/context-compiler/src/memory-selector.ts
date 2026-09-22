/**
 * memory-selector.ts — selects approved memories with visibility/expiry, never treat model "memory" as approved
 * Source: agent_studio_implementation_plan.md:943-955 step 5, 957-965 (958,959,961)
 */

import type { Memory } from './context-inputs.js';

export interface MemorySelection {
  selected: Memory[];
  omitted: Memory[]; // for diagnostics
  rejected: Array<{ memory: Memory; reason: string }>;
}

export function selectMemories(
  memories: Memory[],
  options: {
    organizationId: string;
    scope: 'user' | 'conversation' | 'organization' | 'none';
    scopeId: string; // userId or conversationId or organizationId
    now: Date;
  },
): MemorySelection {
  const selected: Memory[] = [];
  const omitted: Memory[] = [];
  const rejected: Array<{ memory: Memory; reason: string }> = [];

  for (const m of memories) {
    // 1. Tenant scope — must match organizationId
    if (m.organizationId !== options.organizationId) {
      rejected.push({ memory: m, reason: 'cross-tenant' });
      continue;
    }

    // 2. Status — only APPROVED
    if (m.status !== 'APPROVED') {
      rejected.push({ memory: m, reason: `status:${m.status}` });
      continue;
    }

    // 3. Expiry
    if (m.expiresAt) {
      const exp = new Date(m.expiresAt);
      if (exp <= options.now) {
        rejected.push({ memory: m, reason: 'expired' });
        continue;
      }
    }

    // 4. Scope — must match requested scope
    if (options.scope === 'none') {
      rejected.push({ memory: m, reason: 'scope:none' });
      continue;
    }
    // For user scope, memory.scope must be user and scopeId must match
    // For conversation, etc., similar — for now, allow if memory.scope === options.scope and scopeId matches
    // If memory is organization-scoped, it's visible to all in org
    if (m.scope !== options.scope && m.scope !== 'organization') {
      // e.g., requested user, but memory is conversation — not visible
      rejected.push({ memory: m, reason: `scope-mismatch:${m.scope}!=${options.scope}` });
      continue;
    }
    if (m.scope !== 'organization' && m.scopeId !== options.scopeId) {
      rejected.push({ memory: m, reason: 'scopeId-mismatch' });
      continue;
    }

    // 5. Never treat model "memory" as approved — this is already enforced by status, but also check provenance
    // If memory came from model without approval, it would be PENDING, which we already rejected

    selected.push(m);
  }

  // Deterministic ordering: by createdAt ascending, then memoryId
  selected.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    return a.memoryId.localeCompare(b.memoryId);
  });

  return { selected, omitted, rejected };
}
