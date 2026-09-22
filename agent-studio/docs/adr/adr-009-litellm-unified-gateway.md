# ADR-009 — LiteLLM Unified Gateway for 100+ Providers (Phase 9)

- Status: accepted
- Deciders: Agent Studio architecture, `agent_studio_architecture.md:444,486`, `ledger.md:9.1-9.5`
- Date: 2026-09-02

## Context

Phase 9 requires second+ providers beyond OpenAI, with explicit per-provider matrix, auditable
fallback, and usage reconciliation. LiteLLM provides a single unified interface to 100+ LLM
providers (OpenAI, Anthropic, Gemini, Bedrock, Azure, Groq, Mistral, Cohere, Together AI, DeepSeek,
Perplexity, Ollama, etc.) using the OpenAI format, via both Python SDK
`litellm.completion(model="provider/model", messages, ...)` and self-hosted Proxy Server
`ghcr.io/berriai/litellm:main-latest` with `config.yaml`, virtual keys, spend tracking, guardrails,
load balancing, and Router fallbacks (`fallbacks`, `context_window_fallbacks`,
`content_policy_fallbacks`) — see https://docs.litellm.ai/docs/ ,
https://docs.litellm.ai/docs/simple_proxy , https://docs.litellm.ai/docs/providers ,
https://docs.litellm.ai/docs/routing-load-balancing .

## Decision

Adopt LiteLLM **behind** `ModelGateway` contract as an **optional self-hosted gateway route** for
customers requiring a separate network boundary / enterprise self-hosted gateway with virtual keys,
cost tracking, guardrails, routing/failover — not as core dependency
(`agent_studio_architecture.md:444`). Implementation:

- `packages/model-gateway/src/providers/litellm.ts` (`providerId: 'litellm'`) implements
  `ProviderAdapter` (same 11-case conformance: streaming, tool round-trip, structured
  success/refusal, timeout, rate-limit+retry-after, invalid, auth, usage, cancellation, redaction)
  but speaks OpenAI-compatible `POST ${baseUrl}/v1/chat/completions` with
  `Authorization: Bearer <virtualKey>` to Proxy. For unit tests, deterministic fake mimics proxy
  response.
- Capability registry `packages/model-gateway/src/capabilities.ts:LITELLM_CAPABILITIES` lists
  representative models for 10+ providers (openai, anthropic, google, groq, bedrock, azure, mistral,
  together_ai, cohere, deepseek) under `litellm/<provider>/<model>` prefix; generic `litellm/*`
  fallback resolves to closest known. Full 100+ via same prefix without code change.
- Native adapters `openai`, `anthropic`, `google` remain direct via `ai-sdk-adapter.ts` (Vercel AI
  SDK) for low-latency direct path; LiteLLM is alternative route when `LITELLM_BASE_URL` configured
  and `litellm/*` model requested.
- Routing `packages/model-gateway/src/routing.ts` treats `litellm/*` like any model:
  `Engine policy snapshot → org allowlist → capability → health → adapter`; fallback
  explicit/auditable (`fallbackModels` + `fallbackEnabled`), preserves output/tool/schema compat,
  never bypasses org retention/residency (`architecture.md:785`). LiteLLM Router internal fallbacks
  (config.yaml) are second layer; Neryva audit is authoritative.
- Matrix published `contracts/provider/matrix.md` with per-provider 11-case support,
  streaming/tool/structured/usage/context/timeout/error/retention/cancellation.
- Deployment: Docker `ghcr.io/berriai/litellm:main-latest --config /app/config.yaml` with
  `model_list` +
  `router_settings: {routing_strategy: simple-shuffle, num_retries: 2, fallbacks: [...]}`
  https://docs.litellm.ai/docs/routing . Studio `LITELLM_BASE_URL` (default
  `http://localhost:4000`) + `LITELLM_VIRTUAL_KEY` via `secret-provider`, never in workflow/logs.

## Consequences

- Positive: One gateway covers 100+ providers without per-provider SDK juggling; unified
  OpenAI-compatible interface reduces integration overhead; self-hosted control for compliance,
  budgets, RBAC, SSO (enterprise) https://docs.litellm.ai/docs/simple_proxy ; fallback/routing via
  config.yaml + Neryva routing.
- Negative: Python operational dependency for Proxy deployment; must secure/monitor gateway; virtual
  key rotation; cost tracking via Proxy + Engine ledger reconciliation.
- Mitigation: Keep LiteLLM behind `ModelGateway` contract; pin `ai@^4.3` and LiteLLM proxy version
  via lockfile; upgrade via 11-case conformance; fallback is policy-controlled and auditable; usage
  normalized via `usage.ts` same shape.

## Alternatives Considered

- Make LiteLLM core dependency — rejected per ADR-006 (introduces Python operational dependency for
  all deployments).
- Use only direct Vercel adapters for each provider — viable for top 3, but LiteLLM gives 100+
  coverage with one adapter.

## Verification

- `packages/model-gateway/tests/providers/litellm.test.ts` 11 cases + unified 100+ provider test +
  redaction + gateway integration.
- `packages/model-gateway/tests/litellm-fallback.test.ts` 5 fallback cases.
- `packages/model-gateway/tests/usage-litellm.test.ts` 5 usage reconciliation.
- `pnpm check:dependencies` DAG clean, `pnpm check:container` clean, `matrix.md` reviewed.
