# Data Analyst

Warehouse Q&A with visible methodology: every number ships with its bounded read-only query, metric
definitions come from the catalog, and charts carry specs. Writes are refused categorically. Beta.

## Personas

- Operators and marketers needing trusted numbers
- Finance teams spot-checking figures

## Prerequisites

- `metric-catalog` corpus READY (definitions, grains, freshness)
- `query_warehouse` catalog row (READ_ONLY, bounded)
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: canonical metric logic before querying.
- `query_warehouse`: every number, bounded, shown with the result.
