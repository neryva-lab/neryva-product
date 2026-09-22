---
name: studio-mcp-client
description:
  Implement Neryva MCP client for Agent Studio — generated @neryva/mcp-contract, interceptors,
  workload identity, run-scoped capability, and claim-check. Use when touching
  packages/neryva-mcp-client, packages/security, or handling AcquireOrRenewRunLease,
  GetAuthorizedRunContext, AppendRunEvents, CommitRunResult.
---

# Studio MCP Client — Generated Contract & Scoped Capabilities (Phase 2)

Studio side of `neryva.mcp.v1`. Engine is authority. Studio never has Engine DB credentials.

## When to use

- Editing
  `packages/neryva-mcp-client/src/{client,interceptors,capability,idempotency,retry,error-mapping,claim-check,generated}.ts`
  (`agent_studio_implementation_plan.md:271-287`)
- Adding
  `packages/security/src/{workload-identity,capabilities,scope,secret-provider,egress,sensitive-data}.ts`
- Implementing `claimRun`, `getAuthorizedRunContext`, `appendRunEvents`, `commitRunResult`,
  `saveCheckpointRef`, or handling capability expiry/terminal-run errors
- Changing `contracts/mcp/dependency.md` pinned version

## Workflow

### 1. Contract source — pinned dependency, not proto owner (`agent_studio_implementation_plan.md:618-630`)

- Canonical proto lives at `../neryva_mcp/neryva-mcp-contract/proto/neryva/mcp/*/v1/`
  (`common,identity,run,context,event,tool,approval,checkpoint,runtime` `250-254`). `buf.yaml:1`
  lint STANDARD, `buf.gen.yaml:1` generates `gen/ts` via `bufbuild/es` + `connectrpc/es`.
- Studio consumes `contracts/mcp/dependency.md` pinned `neryva.mcp.v1` version + generated
  `@neryva/mcp-contract` package. Never hand-copy types (`630`). CI fails when pinned version /
  generated API / conformance baseline drift. Do not add removed `@connectrpc/protoc-gen-connect-es`
  (`210`).

### 2. Client layers (`agent_studio_implementation_plan.md:632-641`)

```
generated transport client → protocol interceptors → scope/capability verifier → retry/idempotency → bounded claim-check → domain client
```

- Domain methods map explicitly: `claimRun→AcquireOrRenewRunLease`,
  `getAuthorizedRunContext→GetAuthorizedRunContext`, `appendRunEvents→AppendRunEvents`,
  `createApprovalRequest→CreateApprovalRequest`, `submitMemoryProposal→SubmitMemoryProposal`,
  `authorizeToolCall→AuthorizeToolCall`, `recordToolOutcome→RecordToolOutcome`,
  `saveCheckpointRef→SaveCheckpointRef`, `commitRunResult→CommitRunResult`, `failRun→FailRun`,
  `releaseRunLease→ReleaseRunLease` (`644-657`). `getAgentVersion` etc are sub-ops of
  `GetAuthorizedRunContext` (`659`).
- Every request attaches
  `request_id, organization_id, conversation_id, run_id, agent_version_id, actor_id/service_identity, correlation_id, protocol_version, idempotency_key`
  (`305-317`, `662`). Never allow caller to override
  `organization_id/conversation_id/run_id/agent_version_id` scope fields.

### 3. Retry policy (`agent_studio_implementation_plan.md:663-671`)

- Retry only methods documented as idempotent.
- Never blindly retry tool effects or finalization without stable `idempotency_key`
  (`run_id + step_id`).
- Respect server deadlines and `retry-after` hints.
- Bound attempts and total elapsed time.
- Map `capability expiry`, `stale run`, `terminal run`, `authorization denial`, `protocol mismatch`
  to non-retryable domain errors.
- Emit metrics for retries and exhausted attempts.

### 4. Claim-check policy (`agent_studio_implementation_plan.md:672-687`)

- Inline only below tested size threshold + classification limit.
- Larger/sensitive uses Engine-authorized `ArtifactRef`
  (`artifact_id, organization_id, run_id/resource scope, purpose, content-type, byte length, sha256, expiry/retention`
  `674-685`). Purpose enum allowlisted, not free string. Every read does fresh authorization — ref
  is not bearer token (`687`).

### 5. Workload identity and security (`agent_studio_implementation_plan.md:356-364`, `1164-1192`)

- Workload identity per deployment; `runtime-worker` gets only MCP execution access + Temporal
  permissions + assigned secret-manager creds + claim-check path — no broad Engine
  DB/object-store/billing creds (`1166`).
- Capability per operation verified:
  `signature/key version, expiry, not-before, org/conv/run/agent version, actor identity, allowed capabilities, replay protection`
  (`1177-1192`) → terminal auth error, do not repair scope.
- Secrets are references to secret manager, not values; provider credentials never in workflow
  input/logs/definitions/MCP claims (`605`).

### 6. Tests

- `conformance.test.ts`: generated client/server compat, envelope 8+8 fields, `ArtifactRef` 8 fields
- `capability.test.ts`: scope immutability, expiry/revocation
- `retry.test.ts`: idempotent vs non-retryable mapping
- `claim-check.test.ts`: threshold, purpose allowlist, fresh auth

## Anti-patterns

- Putting Neryva MCP network client inside `packages/workflows` (must be inside `activities` only)
  (`491-503`).
- Letting caller-supplied `organization_id` override Engine-scoped value (`662`).
- Retrying `CommitRunResult` without stable idempotency key or blindly retrying `AuthorizeToolCall`
  side effects (`665`).

## References

- `agent_studio_implementation_plan.md:618-687` client, `356-364` secret boundaries, `1164-1192`
  capability
- `agent_studio_architecture.md:232-321` Neryva MCP 4 areas, `305-321` envelope + capability
- `docs/architecture/agent_studio/imp/ledger.md:134-160` Phase 2 checklist
- `../neryva_mcp/neryva-mcp-contract/proto` — `neryva.mcp.v1` (consume via
  `contracts/mcp/dependency.md`)

## Exit gates (Phase 2)

- Fake Engine conformance suite passes; scope cannot be changed by caller
- Duplicate calls produce one Engine effect; conflicting idempotency key → error
- Capability expiry + terminal-run behavior tested
