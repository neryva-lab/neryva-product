# Appointment Setter

Simple booking done right: one clarifying round for gaps, verbatim slot proposals, explicit
confirmation, reference-backed answers. Tight budgets for high-volume scheduling.

## Personas

- Website visitors booking demos and calls
- Customers rescheduling with support

## Prerequisites

- `scheduling-policy` corpus READY (hours, blackouts, durations)
- `create_meeting` catalog row (MUTATING, approval REQUIRED)
- Model access to `anthropic/claude-haiku-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: hours, blackouts, and confirmation rules.
- `create_meeting`: full confirmed slot only, stated first.
