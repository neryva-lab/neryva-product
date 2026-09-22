/**
 * dependencies.ts — wiring of workload identity + MCP transport + per-run client manager
 * Source: agent_studio_implementation_plan.md:356-364, 1164-1173, 98-127
 * Workload identity per deployment; runtime-worker gets only MCP execution access + Temporal + claim-check.
 * One shared worker serves many runs: the MCP client is created PER RUN (scope + capability are
 * run-scoped), never once per worker and never one worker per organization.
 */

import { createConnectTransport } from '@connectrpc/connect-node';
import type { Config } from './config.js';
import { NeryvaMcpClient, type NeryvaMcpClientOptions } from '@neryva/neryva-mcp-client';
import type { Transport } from '@connectrpc/connect';
import type { CapabilityToken } from '@neryva/neryva-mcp-client';
import { createWorkloadIdentity } from '@neryva/security';

export interface RunScope {
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  actorId: string;
}

/**
 * Bootstrap capability — pre-claim identity. Engine has not yet issued the run-scoped
 * capability, so this identity may ONLY claim/release the lease and fetch the authorized
 * context for the run it is about to claim. Every mutating RPC requires the Engine-issued
 * capability, which replaces this after a successful claim.
 */
function bootstrapCapability(config: Config): CapabilityToken {
  const identity = createWorkloadIdentity('runtime-worker', config.runtime.environment);
  return {
    capabilityId: `bootstrap_${config.runtime.serviceName}_${config.neryvaMcp.keyId}`,
    organizationId: '*',
    conversationId: '*',
    runId: '*',
    agentVersionId: '*',
    actorId: `service:${identity.serviceName}`,
    allowedMethods: ['AcquireOrRenewRunLease', 'ReleaseRunLease'],
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    keyId: config.neryvaMcp.keyId,
  };
}

/**
 * Engine capability op → Studio RPC method names, for the Studio-side decoded
 * view of a dispatch-issued capability. The Engine is the real authorizer;
 * this mapping keeps client-side fail-closed checks accurate.
 */
const CAPABILITY_OP_METHODS: Record<string, string[]> = {
  lease: ['AcquireOrRenewRunLease', 'ReleaseRunLease'],
  context: ['GetAuthorizedRunContext'],
  search_knowledge: ['SearchKnowledge'],
  append_events: ['AppendRunEvents'],
  approval: ['CreateApprovalRequest', 'GetApprovalState'],
  memory_proposal: ['SubmitMemoryProposal'],
  tool: ['AuthorizeToolCall', 'RecordToolOutcome', 'GetToolCredential'],
  checkpoint: ['SaveCheckpointRef', 'GetLatestCheckpoint', 'SaveConversationSummary'],
  commit: ['CommitRunResult', 'FailRun'],
  observe: ['GetRunArtifact', 'PutRunArtifact'],
  escalation: ['RequestHumanHandoff'],
  artifact: ['PutRunArtifact', 'GetRunArtifact'],
};

/**
 * Decode the Engine-issued dispatch capability JWT into the Studio-side
 * CapabilityToken view. The signature is NOT verified here — the Engine
 * re-verifies the presented JWT on every RPC; Studio fails closed on a
 * malformed payload. The capability_id is taken from the JWT itself: the
 * relayed capabilityId parameter carries the Engine's request-context value
 * ('engine-dispatch'), which is NOT the token's capability_id.
 *
 * Exported for unit tests (pure function).
 */
export function capabilityFromDispatchJwt(
  scope: RunScope,
  capabilityToken: string,
  _capabilityId: string,
): CapabilityToken {
  const parts = capabilityToken.split('.');
  const payloadB64 = parts[1];
  if (parts.length !== 3 || !payloadB64) {
    throw new Error('dispatch capability is not a well-formed JWT');
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('dispatch capability payload is not valid JSON');
  }
  const capabilityId = claims['capability_id'];
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    throw new Error('dispatch capability has no capability_id claim');
  }
  const allowedOps = Array.isArray(claims['allowed_ops'])
    ? (claims['allowed_ops'] as unknown[]).filter((op): op is string => typeof op === 'string')
    : [];
  const allowedMethods = [...new Set(allowedOps.flatMap((op) => CAPABILITY_OP_METHODS[op] ?? []))];
  const exp = typeof claims['exp'] === 'number' ? claims['exp'] * 1000 : 0;
  const iat = typeof claims['iat'] === 'number' ? claims['iat'] * 1000 : 0;
  return {
    capabilityId,
    organizationId: typeof claims['organization_id'] === 'string' ? claims['organization_id'] : scope.organizationId,
    conversationId: typeof claims['conversation_id'] === 'string' ? claims['conversation_id'] : scope.conversationId,
    runId: typeof claims['run_id'] === 'string' ? claims['run_id'] : scope.runId,
    agentVersionId:
      typeof claims['assistant_version_id'] === 'string' ? claims['assistant_version_id'] : scope.agentVersionId,
    actorId: typeof claims['sub'] === 'string' ? claims['sub'] : scope.actorId,
    allowedMethods,
    issuedAt: iat,
    expiresAt: exp,
    keyId: typeof claims['kid'] === 'string' ? claims['kid'] : '',
    ...(typeof claims['lease_epoch'] === 'number' ? { leaseEpoch: claims['lease_epoch'] } : {}),
  };
}

/**
 * Per-run MCP client manager. One transport (worker-wide), one client per run
 * (scope + capability are run-scoped). Claim updates the cached client so post-claim
 * RPCs carry the Engine-issued capability.
 */
export class McpClientManager {
  private readonly clients = new Map<string, NeryvaMcpClient>();

  constructor(
    private readonly transport: Transport,
    private readonly config: Config,
  ) {}

  /** Client used to claim the run (bootstrap identity). Cached per runId. */
  bootstrapClient(scope: RunScope): NeryvaMcpClient {
    const existing = this.clients.get(scope.runId);
    if (existing) return existing;
    const client = new NeryvaMcpClient({
      transport: this.transport,
      capability: bootstrapCapability(this.config),
      grantedScope: scope,
      protocolVersion: `${this.config.neryvaMcp.protocolMajor}.0`,
    } satisfies NeryvaMcpClientOptions);
    this.clients.set(scope.runId, client);
    return client;
  }

  /**
   * Client built from the Engine-issued dispatch capability JWT. This is the
   * production path: runtime-control relays the dispatch capability through
   * the workflow input, and the worker presents it as Authorization: Bearer
   * on every Engine MCP RPC — including the first one (claim/lease).
   */
  dispatchClient(scope: RunScope, capabilityToken: string, capabilityId: string): NeryvaMcpClient {
    const existing = this.clients.get(scope.runId);
    if (existing) return existing;
    const client = new NeryvaMcpClient({
      transport: this.transport,
      capability: capabilityFromDispatchJwt(scope, capabilityToken, capabilityId),
      capabilityJwt: capabilityToken,
      grantedScope: scope,
      protocolVersion: `${this.config.neryvaMcp.protocolMajor}.0`,
    } satisfies NeryvaMcpClientOptions);
    this.clients.set(scope.runId, client);
    return client;
  }

  /** Replace the cached client with an Engine-issued capability (post-claim). */
  upgradeClient(scope: RunScope, capability: CapabilityToken): NeryvaMcpClient {
    const client = new NeryvaMcpClient({
      transport: this.transport,
      capability,
      grantedScope: scope,
      protocolVersion: `${this.config.neryvaMcp.protocolMajor}.0`,
    } satisfies NeryvaMcpClientOptions);
    this.clients.set(scope.runId, client);
    return client;
  }

  /** Fail-closed run client: no client without a successful claim. */
  clientForRun(runId: string): NeryvaMcpClient {
    const client = this.clients.get(runId);
    if (!client) {
      throw new Error(`MCP_RUN_NOT_CLAIMED:${runId}`);
    }
    return client;
  }

  /** Drop per-run state after terminal outcome — bounded worker memory. */
  evictRun(runId: string): void {
    this.clients.delete(runId);
  }
}

export interface Dependencies {
  mcpManager: McpClientManager;
  transport: Transport;
  config: Config;
}

export async function createDependencies(config: Config): Promise<Dependencies> {
  // Real Connect transport to the Engine MCP authority — no network at construction.
  // HTTP version is configurable; the Engine serves HTTP/1.1 by default.
  const transport = createConnectTransport({
    baseUrl: config.neryvaMcp.endpoint,
    httpVersion: config.neryvaMcp.httpVersion,
  });
  const mcpManager = new McpClientManager(transport, config);
  return { mcpManager, transport, config };
}
