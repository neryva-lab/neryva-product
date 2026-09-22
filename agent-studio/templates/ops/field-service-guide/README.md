# Field Service Guide

On-site quoting and return-visit booking for field teams: verified scope, book prices, one proposal
per run, confirmed follow-ups. The quote-builder pattern adapted for field use.

## Personas

- Field technicians quoting on site
- Dispatchers booking return visits

## Prerequisites

- `service-price-book` corpus READY (rates, parts, procedures)
- `generate_quote` (MUTATING, approval REQUIRED, rate_limit_per_run=1) + `create_meeting` (MUTATING,
  approval REQUIRED) catalog rows
- Model access to `anthropic/claude-haiku-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: book lines and procedures before numbers.
- `generate_quote`: exact approved items + total, once per run.
- `create_meeting`: follow-up visits after slot confirmation.
