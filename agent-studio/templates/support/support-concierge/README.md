# Support Concierge

Tier-1 resolution plus precise escalation, with approved ticket updates. Looks up tickets before
interrogating users; escalates with repro context.

## Personas

- Customers with product issues and an existing ticket
- Support leads measuring resolution and escalation precision

## Prerequisites

- `help-center` corpus READY
- `search_tickets` (READ_ONLY) + `update_ticket` (MUTATING, approval REQUIRED) catalog rows —
  installs without them report `required_tool_missing`
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: known-issue fixes, numbered and verifiable.
- `search_tickets`: before asking for anything the ticket holds.
- `update_ticket`: exact confirmed text only, behind approval.
- `request_human_handoff`: severity or second failed attempt, with context.
