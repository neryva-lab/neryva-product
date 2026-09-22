# Provider Feature Matrix — Model Gateway

> Source: `agent_studio_architecture.md:772-790`, `agent_studio_implementation_plan.md:1511-1513`
> (per-provider matrix, unsupported → clear failure not silent degrade) Capabilities are source of
> truth `packages/model-gateway/src/capabilities.ts`. LiteLLM proxy is optional self-hosted route
> for separate network boundary (`agent_studio_architecture.md:444`) — must remain behind Neryva
> Model Gateway contract, not core.

## Capability Registry

| modelId                                      | providerId | contextWindow | maxOutput | streaming | tools | structured | vision | json | cost prompt/1k¢ | cost completion/1k¢ | available |
| -------------------------------------------- | ---------- | ------------- | --------- | --------- | ----- | ---------- | ------ | ---- | --------------- | ------------------- | --------- |
| openai/gpt-4o-mini                           | openai     | 128k          | 16384     | ✅        | ✅    | ✅         | ✅     | ✅   | 1.5             | 6                   | ✅        |
| openai/gpt-4o                                | openai     | 128k          | 16384     | ✅        | ✅    | ✅         | ✅     | ✅   | 25              | 100                 | ✅        |
| anthropic/claude-3-5-sonnet                  | anthropic  | 200k          | 8192      | ✅        | ✅    | ✅         | ✅     | ❌   | 30              | 150                 | ✅        |
| google/gemini-1.5-pro                        | google     | 1M            | 8192      | ✅        | ✅    | ✅         | ✅     | ✅   | 12.5            | 50                  | ✅        |
| litellm/openai/gpt-4o                        | litellm    | 128k          | 16384     | ✅        | ✅    | ✅         | ✅     | ✅   | 25              | 100                 | ✅        |
| litellm/anthropic/claude-3-5-sonnet          | litellm    | 200k          | 8192      | ✅        | ✅    | ✅         | ✅     | ❌   | 30              | 150                 | ✅        |
| litellm/google/gemini-1.5-flash              | litellm    | 1M            | 8192      | ✅        | ✅    | ✅         | ✅     | ✅   | 7.5             | 30                  | ✅        |
| litellm/groq/llama-3.3-70b                   | litellm    | 128k          | 8192      | ✅        | ✅    | ❌         | ❌     | ❌   | 5.9             | 7.9                 | ✅        |
| litellm/bedrock/anthropic.claude-3-5-sonnet  | litellm    | 200k          | 8192      | ✅        | ✅    | ✅         | ✅     | ❌   | 30              | 150                 | ✅        |
| litellm/azure/gpt-4o                         | litellm    | 128k          | 16384     | ✅        | ✅    | ✅         | ✅     | ✅   | 25              | 100                 | ✅        |
| litellm/mistral/mistral-large                | litellm    | 128k          | 8192      | ✅        | ✅    | ✅         | ❌     | ✅   | 20              | 60                  | ✅        |
| litellm/together_ai/meta-llama/Llama-3.3-70B | litellm    | 128k          | 8192      | ✅        | ❌    | ❌         | ❌     | ❌   | 8               | 8                   | ✅        |
| litellm/cohere/command-r-plus                | litellm    | 128k          | 4096      | ✅        | ✅    | ❌         | ❌     | ❌   | 30              | 30                  | ✅        |
| litellm/deepseek/deepseek-chat               | litellm    | 64k           | 8192      | ✅        | ✅    | ✅         | ❌     | ✅   | 1.4             | 2.8                 | ✅        |

LiteLLM proxy adds 100+ additional models via same OpenAI-compatible interface at
`http://localhost:4000` (or configured `baseUrl`): bedrock (anthropic, meta, ai21), azure, groq,
mistral, cohere, together_ai, deepseek, perplexity, ollama, huggingface, databricks, datarobot,
deepinfra, fireworks_ai, etc. See https://docs.litellm.ai/docs/providers for full list. All via same
`litellm/<provider>/<model>` prefix and unified `completion()`-style call.

## Per-Provider 11-Case Matrix (streaming, tools, structured success/refusal, usage, context limits, timeout, error normalization, retention, cancellation)

| Case                                      | openai                    | anthropic         | google                | litellm (proxy)                    |
| ----------------------------------------- | ------------------------- | ----------------- | --------------------- | ---------------------------------- |
| 1 text                                    | ✅                        | ✅                | ✅                    | ✅ (via proxy)                     |
| 2 streaming + termination                 | ✅ stop                   | ✅ stop           | ✅ STOP               | ✅ stop (OpenAI-compatible chunks) |
| 3 tool round-trip                         | ✅ search_tickets {query} | ✅ search_tickets | ✅ search_tickets     | ✅ same via proxy                  |
| 4 structured success                      | ✅                        | ✅                | ✅                    | ✅                                 |
| 5 structured refusal (safety)             | ✅ content-filter         | ✅ content_filter | ✅ SAFETY             | ✅ content_filter                  |
| 6 timeout (30s)                           | ✅ TIMEOUT retryable      | ✅                | ✅                    | ✅                                 |
| 7 rate-limit + retry-after 100ms          | ✅ RATE_LIMITED           | ✅                | ✅                    | ✅ (from proxy 429 + Retry-After)  |
| 8 invalid request                         | ✅ INVALID_REQUEST        | ✅                | ✅                    | ✅                                 |
| 9 auth failure 401/403                    | ✅ AUTH_FAILED            | ✅                | ✅                    | ✅ virtual key                     |
| 10 usage (prompt/completion/total + cost) | ✅ normalized             | ✅                | ✅                    | ✅ same OpenAI usage shape         |
| 11 cancellation AbortSignal → CANCELLED   | ✅                        | ✅                | ✅                    | ✅                                 |
| redaction strict                          | ✅                        | ✅                | ✅                    | ✅ virtual keys redacted           |
| retention config                          | ✅ header not logged      | ✅ 200k window    | ✅ 1M window / SAFETY | ✅ per deployment config.yaml      |
| gateway integration (read-only)           | ✅                        | ✅                | ✅                    | ✅ separate network boundary       |

Unsupported → clear failure: e.g., `structuredOutput` on model without `supportsStructuredOutput`
throws `UNSUPPORTED_FEATURE` (not silent degrade) `1513`. LiteLLM proxy unsupported routes throw
same `NeryvaProviderError` with `providerId: 'litellm'`.

## Fallback

Fallback is explicit, auditable, policy-controlled (`routing.ts`): `requestedModel` →
`fallbackModels[]` if `fallbackEnabled` per `agent_definition.model_policy.fallback_enabled`.
Preserves output/tool/schema compat; never bypasses org retention/residency (`architecture.md:785`).
LiteLLM's own Router fallback (`fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`)
https://docs.litellm.ai/docs/routing-load-balancing is _internal_ to Proxy deployment (config.yaml
`fallbacks: [{litellm/openai/gpt-4o: [litellm/anthropic/claude-3-5-sonnet]}]`) — Neryva routing
remains authoritative for audit (`audit.requested/selected/fallbackUsed/reason`).

## Usage Reconciliation

Provider-normalized
`NeryvaUsage {promptTokens, completionTokens, totalTokens, costCents, providerId, modelId}` via
`usage.ts:normalizeProviderUsage/attachCost` matches Engine `usage_ledger_entries` (drizzle 0027).
LiteLLM proxy returns same OpenAI `usage {prompt_tokens, completion_tokens, total_tokens}`
regardless of underlying provider (openai, anthropic, gemini, groq, etc.) — normalized same way. Do
not sum span tokens; use Engine ledger as source of truth (`usage` vs ledger delta within policy
`1515`).

## LiteLLM Deployment (optional, not core)

- Install: `pip install litellm` or Docker
  `ghcr.io/berriai/litellm:main-latest --config /app/config.yaml`
  https://docs.litellm.ai/docs/simple_proxy
- Config:
  `model_list: [{model_name: "gpt-4o", litellm_params: {model: "openai/gpt-4o", api_key: env}}]` +
  `router_settings: {routing_strategy: simple-shuffle, num_retries: 2, fallbacks: [...]}`
  https://docs.litellm.ai/docs/routing
- Studio Model Gateway `baseUrl` points to proxy (default `http://localhost:4000`), virtual key via
  `LITELLM_VIRTUAL_KEY` env, never in workflow/logs (`secret-provider`).
- Python operational dependency — keep behind `model-gateway` contract per ADR-006, not as core
  dependency.
