# Security — neryva.mcp.v1

## Workload Authentication
- TLS for every connection; **mTLS** + workload identity between Engine and Studio `668-678`.
- **SPIFFE/SPIRE** preferred in Kubernetes: X.509-SVID short-lived, rotation; JWT replayable, avoid where X.509 possible `678`.
- Service identity bound to deployment/env/role; auto rotation; separate prod/non-prod trust domains.

## Run Capability
Short-lived, audience `neryva-agent-studio`, scope `org/conv/run`, `assistant_version`, `policy_version`, `allowed_operations`, `nonce`, `kid`, `lease_epoch`, `issued_at`, `expires_at`, `issuer` `682-693`.
Rejected on: missing/invalid identity, wrong `aud`/`iss`, expired/not-yet-valid, scope mismatch, replayed nonce, stale `lease_epoch`, operation not allowed, cross-org/conv `697-706`. Capability is proof, not replacement for Engine authz `682-693`.

## Interceptor Pipeline
Fixed order per `neryva_mcp_implementation_plan.md:710-723`:
```
TLS → size/decompression → authentication → trace (W3C) → validation → capability → idempotency → authorization → handler → audit/metrics
```
Transport interceptor must not become policy engine; business authz in Engine policy service.

## Data & Tenant Isolation
- Tenant filters **in Engine query before retrieval/serialization**; post-filtering not a boundary `124,566`.
- Vector query must include tenant predicates `566`.
- Artifact facade 7 checks: ID/purpose, run/org scope, short expiry, `sha256==32B` `595`, byte range, content-type allowlist, encryption key policy, deletion status `569-577`; `purpose` allowlist not free string `595`; read is fresh auth `675`.
- Tool auth independent of model output/prompts `125`.
- Every privileged decision audited: `actor/scope/reason/policyVersion/trace` `126,877`.

## Redaction
No secrets/PII in logs/traces/Temporal history/frontend/event payload `123`; redact tool args, validate `sha256` at boundary `595`.

## Key Rotation
Publish verification keys with overlap, include `kid`, reject unknown `kid` after cache refresh, rotate workload certs without restart, test during active runs, audit key version `829-836`.
