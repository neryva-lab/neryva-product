# Lead Qualifier

Crisp discovery, honest verdicts, precise bookings. Disqualifies fast and kindly; books only
qualified leads after explicit slot confirmation. Tight budgets for high-volume inbound.

## Personas

- Inbound website/chat visitors
- SDR teams triaging volume

## Prerequisites

- `sales-playbook` corpus READY (criteria, objections, slot policy)
- `create_meeting` catalog row (MUTATING, approval REQUIRED)
- Model access to `anthropic/claude-haiku-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: criteria and objection handling.
- `create_meeting`: qualified + explicitly confirmed slot only.
