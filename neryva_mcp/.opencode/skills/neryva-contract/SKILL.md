---
name: neryva-contract
description: Protobuf-first contract ownership for neryva.mcp.v1 — Buf lint/breaking/format, codegen, Protovalidate, ConnectRPC alignment, additive evolution, and golden fixtures.
---

# Neryva Contract

Standalone versioned contract package `neryva-mcp-contract/` is the single source of truth. Engine and Studio are consumers, never owners.

## When to use
- Any change to `proto/neryva/mcp/*/v1/*.proto`, `buf.yaml`, `buf.gen.yaml`, error catalog, or `RequestContext`/`ArtifactRef` envelope
- Adding a new RPC/field/enum value, changing deadlines/idempotency, or updating compatibility docs
- CI failures on `buf lint`, `buf breaking`, `buf generate`, or `protovalidate`

## Workflow

### 1. Edit source, never generated code
- Author only in `proto/neryva/mcp/<domain>/v1/*.proto`. Domains: `common, identity, run, context, event, tool, approval, checkpoint, runtime` `neryva_mcp_implementation_plan.md:250-254`
- `gen/ts/` is **generated** via `buf generate` with `@bufbuild/protobuf` + `@bufbuild/protoc-gen-es` + `@connectrpc/connect`. Do not hand-copy types `neryva_mcp_implementation_plan.md:276,1018`
- Do not add removed `@connectrpc/protoc-gen-connect-es` `neryva_mcp_implementation_plan.md:210`

### 2. Schema rules (non-negotiable) `neryva_mcp_implementation_plan.md:264-274`
- `package neryva.mcp.<domain>.v1` from first commit; never reuse field numbers; reserve deleted numbers/names
- `*_UNSPECIFIED = 0` explicit; `oneof` for exclusive bodies; `google.protobuf.Timestamp`/`Duration`
- Small messages + `ArtifactRef`; avoid `Any` in auth paths unless allowlisted; tolerate unknown fields
- Every RPC documents authority, idempotency, retryability, deadline class, side effects `neryva_mcp_implementation_plan.md:274`

Envelope (exact 8 fields each) `neryva_mcp_implementation_plan.md:298-319`:
```proto
message RequestContext { string request_id=1; string organization_id=2; string conversation_id=3; string run_id=4; string actor_id=5; string idempotency_key=6; string protocol_version=7; string capability_id=8; }
message ArtifactRef { string artifact_id=1; string uri=2; string media_type=3; uint64 byte_length=4; bytes sha256=5; string encryption_key_id=6; string purpose=7; google.protobuf.Timestamp expires_at=8; }
```
ID policy: opaque UUIDv7 (RFC 9562) for `organization_id, actor_id, assistant_id, assistant_version_id, conversation_id, message_id, run_id, step_id, tool_call_id, approval_id, event_id, request_id, idempotency_key` `neryva_mcp_implementation_plan.md:326-342`; Studio must not generate canonical `message_id` `344`; `sha256` is exactly 32B `595`

### 3. Service surface — keep small, typed RPCs `neryva_mcp_implementation_plan.md:336-394`
- `RuntimeControlService` (Studio, 5): `StartRun` (deterministic WorkflowID=`run_id` `348`), `CancelRun`, `DeliverRunInput`, `GetRuntimeStatus`, `DrainRuntime`
- `RunAuthorityService` (Engine, 11): `AcquireOrRenewRunLease`, `GetAuthorizedRunContext`, `AppendRunEvents`, `CreateApprovalRequest`, `SubmitMemoryProposal`, `AuthorizeToolCall`, `RecordToolOutcome`, `SaveCheckpointRef`, `CommitRunResult`, `FailRun`, `ReleaseRunLease`
- `RunObservationService` (Engine, 4): `GetRun`, `ListRunEvents`, `WatchRunEvents` (server-streaming), `GetRunArtifact`
- Document every RPC per `compatibility.md` / `error-catalog.md`

### 4. Additive evolution only within `v1` `neryva_mcp_implementation_plan.md:795-826`
- Add optional fields/new enum values safely; tolerate unknown fields; deploy readers before writers; keep old RPCs during migration; use capability negotiation; `v2` only for wire incompatibility
- Pin Buf + generator majors via lockfile; CI runs `buf format --diff && buf lint && buf breaking --against '.git#branch=main' && buf generate && pnpm typecheck && conformance` `neryva_mcp_implementation_plan.md:804-813,827`

### 5. Validation & conformance `ledger.md:99-105,274-276`
- `protovalidate` valid/invalid fixtures at both boundaries
- Golden wire fixtures + JSON mapping, unknown-field/additive tests, max-size/malformed payloads
- Generated TS bindings consumed by Engine fake + Studio fake `ledger.md:59,102`

## Failure modes → fix
- `buf breaking` fails → you reused a field number/name or changed semantics; reserve and add instead
- `sha256 length != 32` → validate at boundary `595`, reject `FAILED_PRECONDITION`
- `STANDARD` lint fails → fix `buf lint` before commit; never suppress without `compatibility.md` note

## References
- `neryva_mcp_implementation_plan.md:232-286` layout + toolchain, `296-306` envelope, `682-693` capability claims
- `ledger.md:47-105` Phase 0-1 checklist + exit gates
