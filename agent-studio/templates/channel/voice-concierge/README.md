# Voice Concierge

Phone front-door: two sentences, confirm-back, handoff at the first sign of friction. Built-ins only
— installs COMPATIBLE everywhere. The reference template for spoken-format discipline (code-checked
sentence count plus judged tone).

## Personas

- Phone callers with quick questions
- After-hours callers needing routing

## Prerequisites

- `brand-docs` corpus READY (short speakable answers need it too)
- Model access to `anthropic/claude-haiku-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: before speaking any fact — callers can't see citations.
- `request_human_handoff`: frustration, double silence, abuse, past two exchanges — with captured
  intent, never a third attempt.
