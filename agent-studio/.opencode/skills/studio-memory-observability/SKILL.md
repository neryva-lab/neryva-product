---
name: studio-memory-observability
description:
  Implement memory/knowledge retrieval, artifact claim-check, citation mapping, durable streaming,
  and OTel observability with redaction. Use when touching packages/memory-retrieval,
  packages/artifacts, packages/telemetry, contracts/events, or handling retrieval authorization,
  ArtifactRef, or WatchRunEvents.
---

# Studio Memory, Artifacts & Observability (Phases 7, 8, 11)

Engine is durable truth for memory/documents. Studio owns selection policy via Engine-mediated
retrieval + claim-check. Token deltas ephemeral; final message durable.

## When to use

- Editing
  `packages/memory-retrieval/src/{memory-client,knowledge-client,retrieval-policy,query-planner,citation-mapper,result-limits}.ts`
  (`256-269`)
- Editing
  `packages/artifacts/src/{references,reader,writer,checksums,size-policy,encryption,retention}.ts`
  (`325-339`)
- Editing
  `packages/telemetry/src/{bootstrap,traces,metrics,attributes,redaction,sampling,semantic-conventions}.ts`
  (`341-353`)
- Handling `SubmitMemoryProposal`, `GetAuthorizedRunContext` retrieval, `WatchRunEvents`,
  `SaveCheckpointRef`, or evaluation

## Workflow

### 1. Memory and retrieval — Engine-mediated, never direct DB (`agent_studio_implementation_plan.md:1030-1055`)

- Components: `memory-client` (fetch candidates, submit proposals), `knowledge-client` (bounded
  citation-bearing results), `retrieval-policy` (scope/policy/expiry/state/budget filter),
  `query-planner` (keyword/vector/hybrid supported by Engine `1039`), `citation-mapper`
  (document/version/chunk provenance `1040`).
- Retrieval result contract (`1042-1055`): each result MUST include
  `source_id/document_version_id/chunk_id`, `organization/visibility scope`, `relevance metadata`,
  `bounded content or ArtifactRef`, `source range/citation`, `retrieval policy version`. Fail closed
  if Engine omits scope/provenance (`1055`).
- Tenant/visibility predicates in Engine query before serialization
  (`agent_studio_architecture.md:556`, `main.md:189`) — not post-filter. Initial `pgvector` +
  PostgreSQL full-text hybrid (`27,556`), migrate only on measured scale/latency/cost (`556`).

### 2. Memory lifecycle (`agent_studio_architecture.md:513-554`)

- Separate stores: conversation messages, in-flight execution, long-term user memory, org knowledge,
  tool results, audit events (`514-521`).
- Memory writes never automatic from `"remember this"` (`523`). Flow:
  `Agent proposes → Engine validates scope/policy → optional user/org approval → stored with provenance/confidence/expiry/visibility/deletion/embedding_ref`
  (`527-537`).
- Memory items:
  `memory_id, organization_id, user_id/scope, source_message_id, content, confidence, created_at/expires_at, visibility, approval_status, embedding_reference`
  (`540-553`).
- Proposals are not truth until Engine policy/approval; retrieval authorized by scope before
  returned (`1030`).

### 3. Artifacts and claim-check (`agent_studio_implementation_plan.md:325-352`, `589-596`)

- `packages/artifacts` handles claim-check refs for large/sensitive payloads.
  `contracts/mcp/dependency.md` ArtifactRef 8 fields + `agent_studio_implementation_plan.md:674`.
- Size policy: `max inline bytes`, `max artifact bytes` per `artifacts` config (`589-596`).
  `size-policy.ts` + `checksums.ts` (sha256) + `encryption.ts` + `retention.ts`.
- Enforcement (`341-352`): reject oversized workflow args, checksum mismatch, wrong purpose,
  sensitive classification oversize; ref is tenant/run scoped, purpose-bound (allowlisted enum
  `SOURCE_DOCUMENT|EXPORT|CHECKPOINT|TOOL_RESULT|TRANSCRIPT`), checksum-verified (`sha256==32B` at
  boundary `595`), expiring, re-authorized fresh on read. Claim-check `purpose` enum allowlisted,
  not free string. Long tool results/transcripts via `ArtifactRef` (`477,1478`).
- Workflow inputs small: IDs/refs/ArtifactRefs only, not full docs (`795`).

### 4. Durable semantic events + ephemeral streaming (`agent_studio_implementation_plan.md:1057-1101`)

- Durable via Neryva MCP `AppendRunEvents` / `CommitRunResult` (`1063-1076`):
  `RunStarted, ContextPrepared, ModelCallStarted/Completed, ToolCallProposed/Approved/Completed, ApprovalRequested/Received, MemoryProposed, RunWarning, RunCompleted/RunFailed`
  (`1063-1076`). Emit after step outcome known, stable `event_id`/`idempotency_key`, bounded payload
  else `ArtifactRef` (`1080-1089`).
- Event rules (`1080-1089`): stable logical event key, emit after outcome, bound size, Engine
  sequence authoritative (Studio-local sequence diagnostic), retry only idempotent appends, don't
  block workflow on best-effort.
- Token deltas ephemeral by default (`1078`); final assistant result + milestones durable via
  Engine. UI reconnects from Engine durable cursor/snapshot (`1078`).
- Ephemeral Redis/Valkey deltas (`1091-1101`): scoped, TTL, bounded buffer/backpressure, explicit
  `max fan-out consumers/run` + drop-oldest policy while retaining terminal/semantic, no creds, not
  assumed delivered, final-state reconciliation via Engine (`main.md:304`,
  `agent_studio_architecture.md:304`).
- Engine streaming contract (`main.md:104-105,408-431`): frontend subscribes to Engine SSE/WebSocket
  via `request_id/run_id/sequence_number/event_id`, reconnects with last `event_id`; Studio's
  `apps/runtime-control` never exposes customer streaming.

### 5. Observability — OTel with redaction (`agent_studio_implementation_plan.md:1135-1162`, `agent_studio_architecture.md:668-670`)

- Span hierarchy (`1139-1150`):
  `Engine/MCP request → Agent Studio workflow run → context compilation → model call → provider request → tool call → external request → approval wait → finalization`.
  W3C context propagation across MCP/Temporal/provider/tool/broker.
- Telemetry data policy (`1153-1161`): default no raw prompts/full docs/tool args/credentials/model
  outputs in logs. Store hashes/sizes/classifications/artifact IDs. Redacted samples only under
  explicit diagnostic mode with expiry+authorization (`1157`). Do not calculate billable usage by
  summing spans — use Engine usage records (`1158`). Avoid high-cardinality labels (raw user IDs,
  message text) in metrics (`1159`). Emit metrics: workflow starts/completions, activity retries,
  provider latency/errors, tool denials, approval age, budget exhaustion, MCP errors, event lag,
  artifact failures (`1160`).
- GenAI conventions: evolving; keep mapping in one module (`telemetry/semantic-conventions.ts`),
  coalesce duplicate generations, do not sum tokens, don't let business logic depend on experimental
  attribute names (`669-670`).
- Bootstrap OTel before app imports (`telemetry/bootstrap.ts`), correlate via
  `request_id/organization_id/conversation_id/run_id/agent_version_id/correlation_id/protocol_version/idempotency_key`
  (`agent_studio_architecture.md:305-321`).

### 6. Evaluation surface (Phase 11, offline) (`agent_studio_implementation_plan.md:1538-1552`, `agent_studio_architecture.md:808-827`)

- Only after runtime stable. Authoring UI produces versioned agent definitions; never mutates live
  workflow (`1551`).
- Components: agent config prompt/tool/knowledge/model/guardrail editors (`1549`), draft validation
  (`1543`), version comparison (`1544`), publish/rollback integration with Engine (`1545`), test
  conversations with isolated budgets (`1546`), trace viewer with redacted refs (`1547`), evaluation
  runner/reports (`1548`).
- Offline evaluation workloads via `apps/eval-worker` (synthetic data, not production content
  `532`); datasets for brand/policy adherence, refusal/escalation, tool selection, citation
  grounding, isolation/redaction, injection resistance, provider compat, regression of published
  versions (`1278-1291`). Reports carry
  `agent_version/model/definition hash/dataset version/evaluator version/thresholds`; favorable eval
  never bypasses security tests (`1291`).

## Tests

- `tenant-filter.test.ts` — tenant/visibility predicates, cross-tenant confusion
- `result-limit.test.ts`, `citation.test.ts` — citation preservation, scope proof
- `authorization.test.ts`, `checksum.test.ts`, `size-policy.test.ts` — `sha256==32B`, purpose
  allowlist, cross-tenant substitution
- `redaction.test.ts` — no secrets in logs/traces/history; diagnostic mode expiry
- `evaluation` — regression thresholds per dataset

## Anti-patterns

- Accepting unscoped search results from Engine without failing closed (`1055`).
- Passing full documents via `GetAuthorizedRunContext` instead of `ArtifactRef` (wrap large values
  `578-596`).
- Using Temporal payload codec as canonical store (it protects confidentiality, not retention
  `848`).
- Exposing raw prompts in traces because "GenAI conventions need it" (`1153-1161`).

## References

- `agent_studio_implementation_plan.md:1030-1101` memory/retrieval/events, `1135-1162`
  observability, `325-352` artifacts
- `agent_studio_architecture.md:513-597` memory/retrieval/persistence, `668-670` OTel
- `docs/architecture/agent_studio/imp/ledger.md:220-250` Phases 7,8,11

## Exit gates (Phases 7, 8, 11)

- Only authorized/ready sources reach context; large data never in workflow args; artifact
  substitution + cross-tenant tests pass; stale refs unusable
- Frontend observation survives disconnect via Engine; durable final not dependent on deltas; trace
  correlation works; secrets absent
- Authoring produces Engine-owned immutable versions; trace/eval never expose secrets
