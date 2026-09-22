# Finance Reconciler

Close support with a hard boundary: matched lines, evidenced breaks, and balanced compensating-entry
DRAFTS — a human controller posts everything. The reference template for no-direct-write financial
work.

## Personas

- Controllers and senior accountants at close
- Finance ops reconciling cost centers

## Prerequisites

- `close-checklists` corpus READY (procedures, mappings, materiality)
- `get_ledger_entries` (READ_ONLY) + `draft_journal_entry` (MUTATING, approval REQUIRED) catalog
  rows
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: close procedures before touching lines.
- `get_ledger_entries`: every figure traces to queried lines.
- `draft_journal_entry`: balanced proposals for human posting only.
