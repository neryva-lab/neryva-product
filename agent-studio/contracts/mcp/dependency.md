# Neryva MCP Contract Dependency — Pinned Version

> **Canonical proto source:** `../neryva_mcp/neryva-mcp-contract` (standalone versioned contract
> package `neryva.mcp.v1`). This file is the **pinned dependency record**, not the proto source. Do
> not edit proto here. See `agent_studio_implementation_plan.md:618-630`.

## Pinned contract

| Field            | Value                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package          | `@neryva/mcp-contract` (`neryva-mcp-contract/package.json:2`)                                                                                                                  |
| Selected version | `0.1.0` (`neryva-mcp-contract/package.json:3`) — `file:../neryva_mcp/neryva-mcp-contract` (local workspace)                                                                    |
| Compatible range | `^0.1.0` — additive `v1` only (FILE breaking)                                                                                                                                  |
| Wire             | Protobuf + ConnectRPC (gRPC-compat) via `buf.yaml:1` (`STANDARD` lint) + `buf.gen.yaml:1` (`bufbuild/es` + `connectrpc/es` to `gen/ts` with `target=ts, import_extension=.js`) |
| Domains          | `common`, `identity`, `run`, `context`, `event`, `tool`, `approval`, `checkpoint`, `runtime` (`neryva-mcp-contract/proto/neryva/mcp/*/v1/*.proto` x9)                          |

## Why pinned, not copied

- Engine and Studio are consumers, never owners (`agent_studio_implementation_plan.md:630`). CI
  fails when pinned version / generated API / conformance baseline drift (`630`).
- Do **not** hand-copy types into `packages/*`; import from generated `gen/ts` via
  `@neryva/mcp-contract` (`neryva_mcp_implementation_plan.md:276,1018`).
- Do **not** add removed `@connectrpc/protoc-gen-connect-es` — Connect v2 uses `protoc-gen-es`
  descriptors (`neryva_mcp_implementation_plan.md:210`).

## Verification (CI)

```bash
pnpm --filter @neryva/mcp-contract generate
pnpm --filter @neryva/mcp-contract gen:check   # buf generate && git diff --exit-code gen/ts
pnpm --filter @neryva/mcp-contract lint        # buf lint
pnpm --filter @neryva/mcp-contract exec buf breaking --against '.git#branch=main'  # FILE breaking
```

- `buf lint` → `STANDARD` must pass (`buf.yaml:6`).
- `buf breaking` → `FILE` must pass (`buf.yaml:9`). `PACKAGE` if publishing cross-language clients.
- `gen/ts` is build artifact — never edit by hand. `pnpm check:generated` validates
  `buf generate && git diff --exit-code`.

## Consumer mapping (Studio side)

Studio's `packages/neryva-mcp-client` maps domain methods to RPCs
(`agent_studio_implementation_plan.md:644-657`):

```
claimRun               → AcquireOrRenewRunLease
getAuthorizedRunContext→ GetAuthorizedRunContext (sub-ops: GetAgentVersion, GetPolicySnapshot, SearchKnowledge, GetMemories)
appendRunEvents        → AppendRunEvents
createApprovalRequest  → CreateApprovalRequest
submitMemoryProposal   → SubmitMemoryProposal
authorizeToolCall      → AuthorizeToolCall
recordToolOutcome      → RecordToolOutcome
saveCheckpointRef      → SaveCheckpointRef
commitRunResult        → CommitRunResult
failRun                → FailRun
releaseRunLease        → ReleaseRunLease
```

`cancelRun` + `deliverRunInput` are Engine→Studio `RuntimeControlService` (Studio server), not
Studio→Engine authority calls (`659`).

## Envelope (8+8 fields) — must attach per RPC

`RequestContext` 8:
`request_id, organization_id, conversation_id, run_id, actor_id, idempotency_key, protocol_version, capability_id`
(`neryva_mcp_implementation_plan.md:298-306`, `agent_studio_architecture.md:305-317`) `ArtifactRef`
8:
`artifact_id, uri, media_type, byte_length, sha256 (32B), encryption_key_id, purpose (enum allowlist), expires_at`
(`neryva_mcp_implementation_plan.md:310-319`)

## Next steps

- Add to root `package.json:dependencies`:
  `"@neryva/mcp-contract": "file:../neryva_mcp/neryva-mcp-contract"`
- Run `pnpm install --frozen-lockfile` after wiring.
- If contract repo is later published to registry, switch to `^0.1.0` registry version and update
  this file + `package.json` atomically.

## Change log

- `2026-09-02` — Initial pin `0.1.0`, `FILE` breaking, 9 domains. Pending: first `pnpm install` will
  generate `pnpm-lock.yaml` entry.
