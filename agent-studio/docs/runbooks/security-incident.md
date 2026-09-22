# Runbook — Security Incident (10.8, 1574)

> 10.8 Supply chain: lockfiles pinned, SBOM, signed artifacts, `pnpm check:dependencies`,
> `pnpm check:container`, SAST/dependency scanning, code signing

## Isolation Incident (cross-tenant scope forgery)

- Detect: `scope.test.ts` + `artifact-isolation.test.ts` failures, audit log `SCOPE_MISMATCH`
- Quarantine: `runtime-control` `CancelRun` + `FailRun` via MCP, not DB
- Verify: `tests/isolation/*.test.ts` pass, no cross-tenant artifact readable

## Prompt Injection / Tool Misuse

- Detect: `tests/security/prompt-injection.test.ts` + red-team fixtures, `ToolGateway` denies
  `drop_database`
- Mitigate: `effect-policy` + `approval-policy` enforced, retrieved content treated as untrusted
- Audit: `tool_denials_total` metric, `ListRunEvents` shows `ToolCallProposed` denied

## Secret Exposure / Credential Rotation

- Detect: `secret-rotation.test.ts` + `redaction.test.ts` (no plaintext in logs/history)
- Rotate: `InMemorySecretProvider.rotate(ref, newValue, newVersion)` keeps overlap, workload
  identity without downtime (`kid` overlap)
- Verify: old version still resolves during overlap, new version after rotation

## Trace/Log Redaction Failure

- Detect: `grep` on OTel export for `sk-`, `credential`, `prompt` plaintext
- Fix: `redaction.ts` ensures `[REDACTED]` in default, diagnostic mode expiring authorized

## Supply Chain

- Lockfiles: `pnpm-lock.yaml` pinned, `pnpm install --frozen-lockfile` green
- SBOM: `infra/sbom.json` generated via
  `pnpm dlx @cyclonedx/cyclonedx-npm --output-file infra/sbom.json`
- Container: `infra/docker/*.Dockerfile` + `pnpm check:container` + image scan
- SAST: `pnpm lint` + `eslint` + `check:dependencies` DAG clean
