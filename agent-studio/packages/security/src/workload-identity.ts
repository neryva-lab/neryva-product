/**
 * workload-identity.ts — distinct workload identity per deployment
 * Source: agent_studio_implementation_plan.md:1164-1173
 * runtime-worker gets only: MCP execution access + Temporal permissions + assigned secret-manager creds + claim-check path
 * No broad object-store/billing/admin creds.
 */

export type WorkloadRole = 'runtime-worker' | 'runtime-control' | 'tool-worker' | 'eval-worker';

export interface WorkloadIdentity {
  role: WorkloadRole;
  serviceName: string;
  environment: string;
  allowedMcpMethods: string[];
  temporalNamespaces: string[];
  secretRefs: string[]; // e.g., ["openai/api-key", "anthropic/api-key"]
}

export function createWorkloadIdentity(role: WorkloadRole, env: string): WorkloadIdentity {
  const base: Record<WorkloadRole, Partial<WorkloadIdentity>> = {
    'runtime-worker': {
      allowedMcpMethods: [
        'AcquireOrRenewRunLease',
        'GetAuthorizedRunContext',
        'AppendRunEvents',
        'CreateApprovalRequest',
        'SubmitMemoryProposal',
        'AuthorizeToolCall',
        'RecordToolOutcome',
        'SaveCheckpointRef',
        'CommitRunResult',
        'FailRun',
        'ReleaseRunLease',
      ],
      temporalNamespaces: ['agent-studio-dev', 'agent-studio-prod'],
      secretRefs: ['openai/api-key'],
    },
    'runtime-control': {
      allowedMcpMethods: ['GetRun', 'ListRunEvents'],
      temporalNamespaces: [],
      secretRefs: [],
    },
    'tool-worker': {
      allowedMcpMethods: [],
      temporalNamespaces: ['tool-worker'],
      secretRefs: ['tool/sandbox-key'],
    },
    'eval-worker': {
      allowedMcpMethods: [],
      temporalNamespaces: [],
      secretRefs: [],
    },
  };
  const b = base[role];
  return {
    role,
    serviceName: `agent-studio-${role}`,
    environment: env,
    allowedMcpMethods: b.allowedMcpMethods ?? [],
    temporalNamespaces: b.temporalNamespaces ?? [],
    secretRefs: b.secretRefs ?? [],
  };
}

export function assertCanCallMcp(identity: WorkloadIdentity, method: string): void {
  if (!identity.allowedMcpMethods.includes(method) && !identity.allowedMcpMethods.includes('*')) {
    throw new Error(`workload ${identity.role} not allowed to call MCP ${method}`);
  }
}
