# Changelog — neryva.mcp.v1

All notable changes to the contract follow additive `v1` policy `docs/compatibility.md`. `buf breaking` guards wire compat.

## 0.5.0 - Suggested follow-ups + generated media events (v1.2 additive)
- **CommitRunResultRequest**: `suggested_followups` (repeated string, max 4 items x 200 chars) — bounded follow-up
  suggestions recorded atomically with the terminal commit and surfaced on the assistant message to
  widget/console consumers (FL-3.4). Wire-compatible: unknown-field tolerance unchanged, no renumbering.
- **event.v1 EventType**: +EVENT_TYPE_MEDIA = 13 (additive enum) and **RunEvent body**: +`MediaBody media = 26`
  (`artifact_id`, `media_type`) — a GENERATED_MEDIA claim-check artifact pinned to the run (FL-3.2). Additive only.

## 0.4.0 - Checkpoints, claim-check writes, structured output (v1.3 additive)
- **ModelParams**: `output_schema` (JSON Schema text, max 16 KiB) - end-to-end structured output from publish through the manifest to the provider (FL-2.14).
- **RunAuthorityService** +2 RPCs (19 total): `PutRunArtifact` (bounded claim-check WRITE for checkpoints/oversized tool results, op `artifact`) and `GetLatestCheckpoint` (resume-from-checkpoint read, op `checkpoint`) (FL-2.13/2.17).
- **event.v1 EventType**: +EVENT_TYPE_THINKING = 12 (reasoning display channel, FL-3.6).
- **RunAuthorityService** +1 RPC (20 total): `GetToolCredential` — scoped disclosure of a customer-endpoint credential for the HTTP tool executor binding; validated against the run pin, audited, never present in the context manifest (FL-2.10).
- **Breaking:** additive only; `buf breaking` clean against 0.3.0.

## 0.3.0 — Approval observation (v1.2 additive)
- **RunAuthorityService** +1 RPC (16 total): `GetApprovalState(GetApprovalStateRequest) → GetApprovalStateResponse` — Studio observes the Engine's durable decision (`PENDING | APPROVED | DENIED | EXPIRED | NOT_FOUND`) for an approval it proposed, keyed by the Studio-chosen `approval_ref`. Closes the park/resume loop: a re-driven run checks the decision before re-parking, so an approved tool call executes and a denied one is skipped. Capability op: `approval`. Safe read; deadline 2s.
- **BoundedMessage**: `attachments` (repeated ArtifactRef, max 4) — claim-check refs for message attachments (vision input). The runtime fetches each via `GetRunArtifact` (fresh authorization) and caps count/bytes before building provider image parts.
- **RunAuthorityService** +1 RPC (17 total): `RequestHumanHandoff(RequestHumanHandoffRequest) → RequestHumanHandoffResponse` — run-originated human escalation via the built-in `request_human_handoff` tool (FL-1.7c). Engine opens the escalation, flips the conversation to `escalated` and emits the lifecycle outbox event in one transaction. Capability op: `escalation` (new op — mint sites must include it).
- **Breaking:** additive only (new RPC, two new messages, one repeated field; no field changes). `buf breaking` clean against 0.2.1.

## 0.2.1 — Harness context supply chain (v1.1 additive)
- **ContextManifest**: `instructions` (<= 32 KiB, org-authored system prompt from the pinned policy snapshot), `model_params` (new `ModelParams`: temperature/max_output_tokens/top_p/reasoning_effort) — the manifest now carries everything a run needs.
- **ToolDescriptor**: `description`, `input_schema_json` (JSON Schema 2020-12 text, <= 16 KiB), `annotations` (new `ToolAnnotations`: read_only/destructive/idempotent/open_world, MCP-aligned hints). A model can finally emit a valid tool call from the manifest alone.
- **MemoryRef**: `content` (<= 2 KiB) + `content_media_type` — approved memories are readable at runtime.
- **KnowledgeRef**: `snippet` (<= 4 KiB), `title`, `score`, `source_range_start/end` (citation byte offsets).
- **RunBudgets**: `max_total_tokens`, `max_cost_micros`, `wall_clock_seconds` (0 = unset).
- **RunAuthorityService** +2 RPCs (13 total): `SearchKnowledge` (agentic mid-run retrieval, ACL-before-scoring, capability op `search_knowledge`) and `SaveConversationSummary` (Studio-produced compaction persisted as Engine business truth, idempotent per `(conversation_id, source_sequence)`).
- **CommitRunResultRequest**: `usage` (`UsageEntry` provider/model/prompt/completion/total tokens) — recorded atomically with the terminal commit; a replayed commit can never double-bill.
- **Breaking:** additive only; new fields are proto3-optional by implicit presence, old readers ignore them (`buf breaking` clean).

## 0.2.0 — Phase 1: Contract v1 freeze & conformance suite
- **RunAuthorityService 11 RPCs** frozen: `AcquireOrRenewRunLease`, `ReleaseRunLease`, `GetRun`, `CommitRunResult`, `FailRun`, `AppendRunEvents`, `GetAuthorizedRunContext`, `CreateApprovalRequest`, `SubmitMemoryProposal`, `AuthorizeToolCall`, `RecordToolOutcome`, `SaveCheckpointRef` (11 per `neryva_mcp_implementation_plan.md:352-366` plus `GetRun` convenience; breaking `FILE`).
- **RuntimeControlService 5 RPCs** frozen: `StartRun` (deterministic `wf-${runId}`), `CancelRun`, `DeliverRunInput`, `GetRuntimeStatus`, `DrainRuntime`.
- **RunObservationService 4 RPCs** frozen: `GetRun`, `ListRunEvents`, `WatchRunEvents` (server-streaming `WatchRunEventsResponse`), `GetRunArtifact`.
- **ApprovalService** DTO frozen: summary/type/scope/expiry/policyVersion/redactedArgs/decisionId `neryva_mcp_implementation_plan.md:384-394` (model cannot self-approve).
- **Envelope** `RequestContext` 8 + `ArtifactRef` 8 with protovalidate (`sha256 32B`, `purpose` allowlist) + 12 opaque UUIDv7 IDs `neryva_mcp_implementation_plan.md:296-306,326-342`.
- **RunState** 10 `UNSPECIFIED..EXPIRED` + 7 transition rules `430-452` (CAS `expected_version→ABORTED`, lease epoch fencing).
- **Event taxonomy** typed `oneof` 14 categories `477-489`; no log strings.
- **Capability** 9 fields `682-693` + 6 reject cases `697-706`; interceptor order `710-723`.
- **Error catalog** 10 families + gRPC mapping + retry class `741-754` (`docs/error-catalog.md`).
- **Compatibility/Security** docs `docs/compatibility.md`, `docs/security.md` + Buf `STANDARD` lint `FILE` breaking.
- **Golden fixtures** `conformance/fixtures/*.json` + conformance `tests/phase1.conformance.test.ts` (JSON mapping, unknown-field tolerance, max-size, illegal transitions, idempotency conflict).
- **Breaking:** additive only; old fixtures readable via `ignoreUnknownFields:true` (binary wire tolerates unknown fields).

## 0.1.0 — Phase 0 spike
- Initial `neryva.mcp.v1` packages: common, identity, run, context, event, tool, approval, checkpoint, runtime
- Envelope `RequestContext` (8) + `ArtifactRef` (8) with protovalidate
- RunAuthorityService (Engine): AppendRunEvents + lease + Commit/Fail; RuntimeControlService (Studio): StartRun deterministic WorkflowID
- Buf STANDARD lint, FILE breaking, es + connect generation
