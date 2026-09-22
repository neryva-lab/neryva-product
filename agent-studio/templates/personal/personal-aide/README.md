# Personal Aide

Per-user productivity aide: triage, draft, schedule, remember — with approval. Memory-first,
PII-minimal, neutral-professional tone.

## Personas

- Individual contributors triaging busywork
- Managers scheduling and drafting with approval gates

## Prerequisites

- `user-docs` corpus (optional; memory carries most of the weight)
- `schedule_meeting` + `send_email` catalog rows (MUTATING/DESTRUCTIVE, approval REQUIRED) —
  installs at orgs without them report `required_tool_missing` until the rows exist
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_memory`: recall preferences before asking again.
- `schedule_meeting`: only after explicit confirmation of time + attendees.
- `send_email`: only the exact approved draft, never a paraphrase.
