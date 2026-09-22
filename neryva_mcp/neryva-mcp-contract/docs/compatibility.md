# Compatibility Policy — neryva.mcp.v1

**Versioning:** `neryva.mcp.<domain>.v1` from first commit `neryva_mcp_implementation_plan.md:264`. Additive only within `v1`; `v2` only for wire/semantic incompatibility `795-802`.

## Rules
- Never reuse field number for different meaning; reserve deleted numbers + names `265-266`.
- Prefer adding fields over changing meaning; use `oneof` for exclusive bodies `267`.
- Explicit `*_UNSPECIFIED = 0` for every enum; `google.protobuf.Timestamp`/`Duration` for time `268`.
- Keep messages small; large values via `ArtifactRef` `285`; avoid `Any` in auth paths unless allowlisted `286`.
- Tolerate unknown fields — do not fail on unknown `287`; JSON mapping ignores unknown with `ignoreUnknownFields:true` (binary wire ignores unknown fields per protobuf spec).
- Document every RPC's **authority, idempotency, retryability, deadline class, side effects** `288,274`.

## Evolution
- Add optional fields / new enum values safely; deploy **readers before writers** `795-802`.
- Keep old RPCs during migration; use capability negotiation for behavior changes `795-802`.
- `v2` only when old clients cannot safely ignore new wire.

## CI
```bash
buf format --diff --exit-code
buf lint   # STANDARD
buf breaking --against '.git#branch=main' # FILE (or PACKAGE) + wire compat for stored/queued messages `804-813`
buf generate
pnpm typecheck && pnpm test # conformance + golden fixtures
```
Pin Buf + generator majors via `pnpm-lock.yaml` + `buf.lock`; do not use floating remote generator `804-813`.

## Runtime Compatibility
Every Studio deployment declares `supported Neryva MCP major/minor`, `agent definition versions`, `artifact formats`, `capability versions`, `model gateway contract version` `820-825`. Engine admission checks before dispatch; rolling deploys must keep both old and new Studio able to handle `v1`. Temporal versioning via `temporal` SDK `827`.

## Verification
- Golden wire fixtures `conformance/fixtures/*.json` + `fromJson`/`toJson` round-trip + unknown-field tolerance `ledger 1.10`.
- Old fixtures remain readable after additive `optional` field; new `oneof` variants tolerated as unknown by old readers.
