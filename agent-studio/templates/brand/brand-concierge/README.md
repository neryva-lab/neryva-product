# Brand Concierge

Organization-branded front-door assistant. Answers from approved knowledge, enforces tone and
claims, hands off cleanly with a context packet.

## Personas

- Website visitors with pre-sales questions
- Customers checking policy, billing, or setup answers
- Voice callers needing short spoken answers with confirm-back

## Prerequisites

- `brand-docs` knowledge corpus ingested and READY (policies, pricing, FAQs)
- Model access to `anthropic/claude-sonnet-4-5` (or remap `model.json` to the org catalog before
  publish — compatibility flags mismatches, never blocks install)
- `web-widget` plus any messaging channels bound per `bindings/channels.json`

## Why only built-in tools

This template requires `search_knowledge` + `request_human_handoff` only — both platform built-ins
that resolve by name at every org. No catalog rows needed, so the template installs COMPATIBLE
everywhere. Templates that need org-owned tools (refunds, ticketing, quotes) pin them in
`bindings/tools.required.json` instead; see `refund-specialist` (Tier 1).

## Tool when_to_use

- `search_knowledge`: before answering any factual question — retrieve APPROVED brand-docs chunks
  first, then answer with citations.
- `request_human_handoff`: on ambiguity, frustration, PII beyond need, or out-of-scope requests —
  always with a context packet, never cold.
