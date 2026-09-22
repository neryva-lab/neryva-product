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
