# Quote Builder

Needs-based quotes inside discount policy: itemized lines traced to the price book, band-checked
discounts, one proposal per run behind approval. The reference template for MUTATING generation
tools with rate limits.

## Personas

- AEs quoting standard + banded-discount deals
- Sales ops auditing quote accuracy

## Prerequisites

- `price-book` corpus READY (SKUs, units, discount band)
- `generate_quote` catalog row (MUTATING, approval REQUIRED, rate_limit_per_run=1)
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: prices and discount bands before any number.
- `generate_quote`: exact approved items + total, once per run.
