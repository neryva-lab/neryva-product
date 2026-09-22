/**
 * dispatch-capability.test.ts — Engine-issued dispatch capability relay.
 *
 * Regression: runtime-control dropped the Engine-issued capability JWT from
 * the Temporal workflow input, so NeryvaMcpClient never sent
 * `Authorization: Bearer` and every Engine MCP RPC failed permission_denied.
 * The relay (internal-control → workflow input → acquireOrRenewRunLease →
 * per-run dispatch client → transport bearer header) is covered here at the
 * decode layer; the transport header itself is covered in
 * neryva-mcp-client/tests/bearer-auth.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  capabilityFromDispatchJwt,
  type RunScope,
} from '../src/dependencies.js';

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeJwt(claims: Record<string, unknown>): string {
  return `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(claims)}.fakesig`;
}

const scope: RunScope = {
  organizationId: 'org-1',
  conversationId: 'conv-1',
  runId: 'run-1',
  agentVersionId: 'av-1',
  actorId: 'actor-1',
};

describe('capabilityFromDispatchJwt', () => {
  it('takes capability_id from the JWT claims, not the relayed request-context id', () => {
    const jwt = makeJwt({
      capability_id: 'cap-true-9f3a',
      organization_id: 'org-1',
      conversation_id: 'conv-1',
      run_id: 'run-1',
      assistant_version_id: 'av-1',
      sub: 'actor-1',
      allowed_ops: ['lease', 'context'],
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    // The relayed capabilityId param is the Engine's request-context value
    // ('engine-dispatch') — NOT the token's capability_id.
    const cap = capabilityFromDispatchJwt(scope, jwt, 'engine-dispatch');
    expect(cap.capabilityId).toBe('cap-true-9f3a');
  });

  it('maps allowed_ops to RPC method names for client-side fail-closed checks', () => {
    const jwt = makeJwt({
      capability_id: 'cap-1',
      allowed_ops: ['lease', 'context', 'commit'],
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const cap = capabilityFromDispatchJwt(scope, jwt, 'engine-dispatch');
    expect(cap.allowedMethods).toContain('AcquireOrRenewRunLease');
    expect(cap.allowedMethods).toContain('GetAuthorizedRunContext');
    expect(cap.allowedMethods).toContain('CommitRunResult');
    expect(cap.allowedMethods).not.toContain('AuthorizeToolCall');
  });

  it('falls back to run scope for claims the JWT does not carry', () => {
    const jwt = makeJwt({ capability_id: 'cap-1', allowed_ops: [] });
    const cap = capabilityFromDispatchJwt(scope, jwt, 'engine-dispatch');
    expect(cap.organizationId).toBe('org-1');
    expect(cap.runId).toBe('run-1');
    expect(cap.actorId).toBe('actor-1');
  });

  it('throws on a malformed JWT (fail-closed)', () => {
    expect(() => capabilityFromDispatchJwt(scope, 'not-a-jwt', 'engine-dispatch')).toThrow(
      /well-formed JWT/,
    );
    const badPayload = `${b64urlJson({ alg: 'HS256' })}.!!!not-base64!!!.sig`;
    expect(() => capabilityFromDispatchJwt(scope, badPayload, 'engine-dispatch')).toThrow();
  });

  it('throws when the capability_id claim is missing', () => {
    const jwt = makeJwt({ allowed_ops: ['lease'] });
    expect(() => capabilityFromDispatchJwt(scope, jwt, 'engine-dispatch')).toThrow(
      /capability_id/,
    );
  });
});
