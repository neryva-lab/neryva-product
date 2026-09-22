# Error Catalog — neryva.mcp.v1

Each error: stable machine-readable code + gRPC/Connect status + safe user-facing message key + retry class + operator diagnostic + redaction class `732-739`. Never expose provider stack, prompts, or topology to end user `756`.

## Families

| Family | Example Codes | gRPC Status | Retry |
|---|---|---|---|
| Validation | `INVALID_ARGUMENT`, `INVALID_REQUEST` | `3 INVALID_ARGUMENT` | No |
| Authentication | `UNAUTHENTICATED`, `CAPABILITY_EXPIRED` | `16 UNAUTHENTICATED` | Re-auth only |
| Authorization | `PERMISSION_DENIED`, `SCOPE_MISMATCH`, `POLICY_DENIED` | `7 PERMISSION_DENIED` | No |
| Concurrency | `ABORTED_STALE_VERSION`, `LEASE_CONFLICT`, `IDEMPOTENCY_CONFLICT` | `10 ABORTED` | Higher-level only `756` |
| Availability | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `OVERLOAD` | `14 UNAVAILABLE` | Conditional `215` |
| Provider | `PROVIDER_RATE_LIMIT`, `CONTEXT_LIMIT`, `SAFETY_BLOCK` | `8 RESOURCE_EXHAUSTED` | Policy-specific |
| Tool | `TOOL_REJECTED`, `TOOL_AMBIGUOUS` | `9 FAILED_PRECONDITION` | No blind retry `609-616` |
| Lifecycle | `TERMINAL_RUN`, `APPROVAL_EXPIRED`, `CANCELLED` | `9 FAILED_PRECONDITION` | No |
| Integrity | `CHECKSUM_MISMATCH`, `ARTIFACT_CORRUPT` | `15 DATA_LOSS` | No; quarantine |
| Internal | `INTERNAL`, `INVARIANT_VIOLATION` | `13 INTERNAL` | Bounded + alert |

## Mapping
- `UNAVAILABLE` is retryable, but **never retry non-idempotent** writes `215`.
- `ABORTED`, `FAILED_PRECONDITION`, `INVALID_ARGUMENT`, `UNAUTHENTICATED` require caller handling, not blind retry `216,756`.
- Every mutating RPC is idempotent or explicitly documented non-retryable `1289`.
- `ALREADY_EXISTS` for `idempotency conflict: different digest` `781-785` + audit.

## Retry Ownership
- MCP transport: only idempotent + `UNAVAILABLE` `218`.
- Temporal: owns Activity retry/backoff `219`.
- Model Gateway: owns provider hints `220`.
- Write tools: no blind retry; use stable `run+step` idempotency key + reconciliation `221,609-616`.

## Safety
- Safe message key for frontend (no secrets/PII); full diagnostic in audit `732-739`.
- Redaction class per error (none/pii/secret).
