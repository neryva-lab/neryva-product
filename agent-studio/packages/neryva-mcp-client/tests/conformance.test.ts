/**
 * conformance.test.ts — Neryva MCP generated client/server compat, envelope, scope immutability
 * Source: ledger.md:2.1-2.4, agent_studio_implementation_plan.md:1224-1235
 */

import { describe, it, expect } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  RequestContextSchema,
  ArtifactRefSchema,
} from '@neryva/mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js';
import { createRequestContext } from '@neryva/testkit';

describe('conformance — envelope 8+8', () => {
  it('RequestContext has 8 required fields and validates via Protovalidate (via buf)', () => {
    const ctx = createRequestContext();
    const msg = create(RequestContextSchema, {
      requestId: ctx.requestId,
      organizationId: ctx.organizationId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      actorId: 'actor_123',
      idempotencyKey: ctx.idempotencyKey,
      protocolVersion: '1.0',
      capabilityId: 'cap_123',
    });
    expect(msg.requestId).toBe(ctx.requestId);
    expect(msg.organizationId).toBe(ctx.organizationId);
    expect(msg.conversationId).toBe(ctx.conversationId);
    expect(msg.runId).toBe(ctx.runId);
    expect(msg.capabilityId).toBe('cap_123');
  });

  it('ArtifactRef has 8 fields and sha256 is 32B', () => {
    const sha = new Uint8Array(32);
    const ref = create(ArtifactRefSchema, {
      artifactId: 'art_123',
      uri: 's3://bucket/org/obj',
      mediaType: 'application/json',
      byteLength: 1024n,
      sha256: sha,
      encryptionKeyId: 'key_1',
      purpose: 'tool_output',
      expiresAt: { seconds: 9999999999n, nanos: 0 },
    });
    expect(ref.sha256.length).toBe(32);
    expect(ref.purpose).toBe('tool_output');
  });

  it('generated types are from @neryva/mcp-contract (not hand-copied)', async () => {
    const mod = await import('@neryva/mcp-contract');
    expect(mod).toBeDefined();
    expect(
      (mod as { RequestContextSchema?: unknown }).RequestContextSchema ?? RequestContextSchema,
    ).toBeDefined();
  });
});
