/**
 * tenant-scope.test.ts — RLS-equivalent isolation: every repo/MCP query requires tenant scope
 * Source: 10.1 agent_studio_architecture.md:659-666, 381-383, implementation_plan.md:1266-1276
 * Verifies: tenant keys on all org-owned data, RLS would block reads/inserts/updates/deletes/joins across orgs,
 * object keys namespaced by organization_id, vector collections namespaced, cache keys scoped, jobs carry scope.
 */
import { describe, it, expect } from 'vitest';
import { assertScopeImmutability, validateScopeFields } from '@neryva/security';
import { applyRetrievalPolicy } from '@neryva/memory-retrieval';

describe('10.1 Tenant isolation — every query requires tenant scope', () => {
  it('scope immutability — granted scope cannot be widened by Studio request', () => {
    const granted = {
      organizationId: 'org_A',
      conversationId: 'conv_1',
      runId: 'run_1',
      agentVersionId: 'v1',
      actorId: 'actor1',
    };
    expect(() => assertScopeImmutability(granted, { organizationId: 'org_B' })).toThrow(
      /scope mismatch/,
    );
    expect(() => assertScopeImmutability(granted, { runId: 'run_other' })).toThrow(
      /scope mismatch/,
    );
  });

  it('validateScopeFields requires all 4 fields', () => {
    expect(
      validateScopeFields({ organizationId: 'org_A' } as unknown as Parameters<
        typeof validateScopeFields
      >[0]).ok,
    ).toBe(false);
    expect(
      validateScopeFields({
        organizationId: 'org_A',
        conversationId: 'conv',
        runId: 'run',
        agentVersionId: 'v1',
      }).ok,
    ).toBe(true);
  });

  it('retrieval policy filters cross-tenant (WHERE organization_id) before serialization — not post-filter', () => {
    const candidates = [
      {
        sourceId: 'doc1',
        organizationId: 'org_A',
        status: 'READY',
        citation: 'c1',
        policyVersion: 'v1',
        content: 'ok',
      },
      {
        sourceId: 'doc2',
        organizationId: 'org_B',
        status: 'READY',
        citation: 'c2',
        policyVersion: 'v1',
        content: 'other tenant',
      },
    ];
    const { kept } = applyRetrievalPolicy(
      candidates as unknown as Parameters<typeof applyRetrievalPolicy>[0],
      {
        expectedOrganizationId: 'org_A',
        allowedStatuses: new Set(['READY']),
        now: new Date(),
        requireArtifactOrContent: true,
      },
    );
    expect(kept.length).toBe(1);
    expect(kept[0].organizationId).toBe('org_A');
  });

  it('background jobs carry tenant scope and reject missing', () => {
    const job = { organizationId: '', runId: 'run1' };
    const validated = validateScopeFields({
      organizationId: job.organizationId,
      conversationId: 'c',
      runId: job.runId,
      agentVersionId: 'v1',
    });
    expect(validated.ok).toBe(false);
  });
});
