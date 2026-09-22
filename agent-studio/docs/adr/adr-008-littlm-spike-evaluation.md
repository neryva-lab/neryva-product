# ADR-008 — LiteLLM Self-Hosted Gateway Route (Spike Evaluation, 4.5a)

Date: 2026-09-02 Status: accepted — optional, not core Deciders: Agent Studio architecture Source:
`agent_studio_architecture.md:444`, `agent_studio_implementation_plan.md:858-920`, ledger 4.5a

## Context

LiteLLM offers unified OpenAI-compatible interface, routing/fallback, virtual keys, spend tracking.
Some enterprise customers require a separate network boundary / provider gateway (e.g., air-gapped
egress via self-hosted proxy). Neryva Model Gateway is the authoritative boundary; LiteLLM would be
an optional route behind it, not replacement.

## Spike

- Deployed `ghcr.io/berriai/litellm:main-latest` with `config.yaml` routing
  `openai/gpt-4o-mini -> openai`, `anthropic/claude -> anthropic`, virtual key per
  `organization_id`.
- Proxied via `ModelGateway` with `providerId: litellm` adapter implementing same `ProviderAdapter`
  contract (`generate/stream`) and capability registry. Routing decision remains in `routing.ts`
  (org allowlist → capability → budget → health → adapter). LiteLLM virtual key is resolved via
  `secret-provider` (same as direct provider keys).
- Conformance matrix (11 cases) via LiteLLM route: text, streaming, tool round-trip, structured
  success/refusal, timeout, rate-limit+retry-after, invalid request, auth failure, usage,
  cancellation, redaction — all passed when upstream provider passed, but added hop latency
  `+12-25ms p50` and Python operational overhead.

## Decision

- **LiteLLM remains optional, behind `NeryvaModelRequest/Response` contract**
  (`contracts/provider/*`) and capability registry (`capabilities.ts:1`). It is not a core
  dependency for v1.
- If a deployment opts in, it does so via `model-gateway` provider `litellm` with
  `baseUrl = https://litellm.internal` and `credentialRefs.litellm = arn:...`. The gateway still
  owns `routing.ts` failover (explicit, auditable, never bypasses retention/residency). LiteLLM's
  own fallback is disabled; Neryva routing is authoritative.
- Python operational dependency is isolated to `tool-worker`/`litellm` deployment, not
  `runtime-worker`. No LiteLLM types leak outside `model-gateway` — same rule as OpenAI
  (`pnpm check:dependencies`).
- No second billing ledger: usage still normalized via `usage.ts:1` and recorded via `Engine/MCP`
  `RecordUsage`, not LiteLLM spend table (which is for ops dashboard only).

## Consequences

- `packages/model-gateway/src/providers/litellm.ts` is not shipped in Phase 4; spike code archived
  in `docs/spike-littlm.md` (not in bundle). Adding it later requires ADR update +
  `tests/providers/litellm.test.ts` conformance + SBOM update.
- `pnpm check:container` remains green: no LiteLLM image in core `Dockerfile`.
- Fallback via LiteLLM still requires explicit policy snapshot allowlist and is logged with
  `audit: { fallbackUsed: true, reason }` (`routing.ts:1`).

## References

- `agent_studio_architecture.md:444` (LiteLLM only behind Model Gateway contract)
- `agent_studio_implementation_plan.md:909-920` (routing authoritative)
- Spike config: `infra/litellm/config.example.yaml` (not committed)
