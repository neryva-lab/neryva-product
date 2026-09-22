# Neryva MCP — AGENTS.md

TypeScript · Protobuf `neryva.mcp.v1` · ConnectRPC (gRPC-compat) · Buf + Protovalidate · Temporal · Engine (authority) + Agent Studio (runtime)

## Commands
```bash
# Contract
buf lint && buf format --diff --exit-code && buf breaking --against '.git#branch=main'
buf generate && pnpm -C neryva-mcp-contract gen:check
# Single RPC repro
pnpm test src/run/__tests__/AppendRunEvents.test.ts -- -t "dedup (run_id,event_id)"
# Full suite
pnpm lint && pnpm typecheck && pnpm test
pnpm test:temporal  # Testcontainers
```

## Project structure
```
neryva-mcp-contract/  # standalone versioned contract: proto/neryva/mcp/*/v1, buf.yaml, gen/ts, conformance/
engine/src/mcp/       # RunAuthorityService + RunObservationService + outbox dispatcher (authority)
studio/src/mcp/       # RuntimeControlService + Temporal bridge (adapter)
docs/architecture/neryva_mcp/  # main.md, neryva_mcp_implementation_plan.md:1-1355, ledger.md:1-328
docs/dev/final_ledger.md      # harness execution ledger (mirror; canonical: engine/docs/dev/final_ledger.md) — FL-* IDs
```

## Code style
- Protobuf first: never hand-copy wire types; import from `gen/ts`. `package neryva.mcp.<domain>.v1` from first commit `neryva_mcp_implementation_plan.md:264`.
- Explicit `*_UNSPECIFIED = 0`, `oneof` for exclusive bodies, reserve deleted fields `neryva_mcp_implementation_plan.md:265-274`.
- `RequestContext` 8 fields + `ArtifactRef` 8 fields + UUIDv7 opaque IDs (RFC 9562) `neryva_mcp_implementation_plan.md:296-306,326`.
- No `Any` in auth paths unless allowlisted. Tolerate unknown fields.

## Testing — run before every commit
- Contract: `buf lint && buf breaking && protovalidate valid/invalid && golden fixtures` `ledger.md:274-276`
- State-machine: every legal/illegal transition + CAS `ABORTED` + lease fencing `ledger.md:278-281`
- Delivery: Engine crash before/after outbox, dispatcher retry same idempotency key, NATS redelivery `ledger.md:282-285`
- Temporal: deterministic replay, heartbeat, Signal during restart `ledger.md:286-289`
- Security: cross-tenant IDs, forged capability, replay, secret leakage in logs/history `ledger.md:290-293`

## Architecture — authority invariants (must hold P1+)
- **Engine owns** `organization_id`, membership, policy, conversation/message IDs, canonical history, terminal state `CommitRunResult` once `main.md:87-110`, `neryva_mcp_implementation_plan.md:95,98`.
- Studio proposes, Engine validates; service identity alone insufficient `neryva_mcp_implementation_plan.md:97,99`.
- At-least-once network → idempotent app: idempotency key required `105`, duplicate returns original, conflict `different digest → reject + audit` `106,780-789`, event dedup `(run_id,event_id)` + Engine `sequence` `107`.
- Temporal history = refs only, large values via claim-check `ArtifactRef` `113-115`; checkpoint loadable by replacement worker `116`.
- Every privileged decision → `audit_log` with actor/scope/reason/policyVersion/trace `neryva_mcp_implementation_plan.md:126,877`.

## Boundaries
- ✅ **Always:** use generated clients; enforce tenant `WHERE` in Engine query before serialization `neryva_mcp_implementation_plan.md:124`; include `organization_id/conversation_id/run_id + idempotency_key + capability_id` per RPC; pass `expected_version` for CAS.
- ⚠️ **Ask first:** adding new RPC/field (needs `buf breaking` + compat note), adding gateway/NATS/Redis, changing run states `QUEUED/CLAIMED/RUNNING/WAITING_*` `430-442`.
- 🚫 **Never:** Studio touches Engine DB `175-177`; put raw docs/secrets/unbounded prompts in Temporal args or event payload `579`; let Studio commit canonical assistant message; use provider conversation ID as source of truth `224`; invent JSON-over-HTTP wire; add `@connectrpc/protoc-gen-connect-es` (removed) `210`.

## Git & PR
- Branch: `feat/mcp-phase{0-8}-{scope}`. Commits: Conventional Commits. CI must run `buf format --diff && buf lint && buf breaking && buf generate && typecheck && conformance` `neryva_mcp_implementation_plan.md:804-813`.
- Do not start Phase N+1 before Phase N exit gates DONE `ledger.md:14`.

## Security
- mTLS + workload identity (SPIFFE X.509-SVID preferred, JWT replayable `668-678`), short-lived capability (aud `neryva-agent-studio`, scope `org/conv/run`, nonce, kid, lease epoch) `682-693`.
- Interceptor order: TLS → size → auth → trace (W3C) → validation → capability → idempotency → authz → audit `710-723`.
- No secrets/PII in logs/traces/history/frontend; redact tool args, validate `sha256==32B` `595` at boundary.

## References
- `docs/main.md:1-444` — Engine vs Studio responsibility split
- `docs/architecture/neryva_mcp/neryva_mcp_implementation_plan.md:89-126` invariants, `232-272` contract, `336-394` services, `414-469` lifecycle+outbox
- `docs/architecture/neryva_mcp/ledger.md:20-32` phase overview, `46-320` checklist (single source of truth)
