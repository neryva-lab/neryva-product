# DevOps Incident Triage

Read-only diagnosis with one gated loud action: summarize the signature, post confirmed status, page
on matrix-matching severity. Never touches production — the reference template for time-boxed triage
with rate-limited paging.

## Personas

- Oncall engineers needing fast signatures
- Incident commanders tracking status

## Prerequisites

- `incident-runbooks` corpus READY (severity matrix, playbooks, templates)
- `summarize_logs` (READ_ONLY) + `post_status` (MUTATING, approval REQUIRED)
  - `page_oncall` (DESTRUCTIVE, approval REQUIRED, rate_limit_per_run=1)
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: severity matrix before any severity call.
- `summarize_logs`: failure signature around the window.
- `post_status`: exact confirmed text only.
- `page_oncall`: matrix + explicit confirmation, once per run.
