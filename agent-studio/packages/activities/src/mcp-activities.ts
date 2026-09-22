/**
 * mcp-activities.ts — all Neryva MCP calls live in Activities (never in workflows)
 * Source: agent_studio_implementation_plan.md:801-812, 1373-1379
 * Workflows call these Activities; Activities handle network, retries, and claim-check.
 */

import { NeryvaMcpClient, type NeryvaMcpClientOptions } from '@neryva/neryva-mcp-client';

export interface McpActivitiesOptions {
  client: NeryvaMcpClient;
}

export function createMcpActivities(client: NeryvaMcpClient) {
  return {
    // Lease
    async acquireOrRenewRunLease(params: {
      expectedLeaseOwner?: string | undefined;
      expectedLeaseEpoch?: bigint | undefined;
      renewUntil?: Date | undefined;
    }): Promise<unknown> {
      return client.claimRun(params);
    },

    async releaseRunLease(leaseEpoch: bigint): Promise<unknown> {
      return client.releaseRunLease(leaseEpoch);
    },

    // Context — sub-ops of GetAuthorizedRunContext (659)
    async getAuthorizedRunContext(requestedPurposes: string[] = []): Promise<unknown> {
      return client.getAuthorizedRunContext(requestedPurposes);
    },

    // Events
    async appendRunEvents(events: Parameters<typeof client.appendRunEvents>[0]): Promise<unknown> {
      return client.appendRunEvents(events);
    },

    // Approval
    async createApprovalRequest(params: {
      approvalId: string;
      toolCallId: string;
      summary?: string | undefined;
      actionType?: string | undefined;
      policyVersion?: string | undefined;
    }): Promise<unknown> {
      return client.createApprovalRequest(params);
    },

    // Memory
    async submitMemoryProposal(params: {
      proposalId: string;
      scope?: string | undefined;
      value: string;
      provenance?: string | undefined;
      confidence?: number | undefined;
      visibility?: string | undefined;
    }): Promise<unknown> {
      return client.submitMemoryProposal(params);
    },

    // Tools
    async authorizeToolCall(params: {
      toolCallId: string;
      stepId: string;
      toolName: string;
      toolVersion: string;
      argumentDigest?: Uint8Array | undefined;
    }): Promise<unknown> {
      return client.authorizeToolCall(params);
    },

    async recordToolOutcome(params: {
      toolCallId: string;
      stepId: string;
      status: string;
      resultDigest?: Uint8Array | undefined;
      resultRef?: Parameters<typeof client.recordToolOutcome>[0]['resultRef'];
    }): Promise<unknown> {
      return client.recordToolOutcome(params);
    },

    // Checkpoint
    async saveCheckpointRef(params: {
      checkpointId: string;
      checkpointVersion: number;
      artifactRef: Parameters<typeof client.saveCheckpointRef>[0]['artifactRef'];
      digest?: Uint8Array | undefined;
      createdAt?: Date | undefined;
    }): Promise<unknown> {
      return client.saveCheckpointRef(params);
    },

    // Terminal — idempotent, exactly once; usage rides the commit (v1.1)
    async commitRunResult(params: {
      resultText: string;
      expectedVersion?: bigint | undefined;
      resultArtifact?: Parameters<typeof client.commitRunResult>[0]['resultArtifact'];
      usage?: {
        provider: string;
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      suggestedFollowups?: string[] | undefined;
    }): Promise<unknown> {
      return client.commitRunResult(params);
    },

    async failRun(params: {
      errorCode: string;
      errorMessage: string;
      expectedVersion?: bigint | undefined;
    }): Promise<unknown> {
      return client.failRun(params);
    },
  };
}

export type McpActivities = ReturnType<typeof createMcpActivities>;

// Factory for tests — uses fake transport via testkit
export function createFakeMcpActivities(opts: NeryvaMcpClientOptions): McpActivities {
  const client = new NeryvaMcpClient(opts);
  return createMcpActivities(client);
}
