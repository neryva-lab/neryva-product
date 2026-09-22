# Knowledge Curator

Turns resolved conversations into review-ready help drafts and reports coverage gaps. Drafts only —
humans publish. Redacts PII and marks unverified steps [NEEDS-SOURCE] by default.

## Personas

- Support leads improving deflection
- Documentation owners reviewing drafts

## Prerequisites

- `help-center` corpus READY (the corpus being extended)
- `draft_article` catalog row (MUTATING, approval REQUIRED)
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: existing-coverage check before every draft.
- `draft_article`: complete reviewed payloads; drafts are not publishes.
