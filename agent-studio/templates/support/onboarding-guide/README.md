# Onboarding Guide

Step-by-step setup coach: one step per turn, verification before advance, patient loops, warm
handoff on repeated failure. Built-ins only — installs COMPATIBLE everywhere.

## Personas

- New users on first setup
- Returning users resuming partial setup

## Prerequisites

- `getting-started` corpus READY (ordered steps + troubleshooting)
- Model access to `anthropic/claude-haiku-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: each step's canonical instructions + verification check.
- `request_human_handoff`: stuck twice on the same step, with step history.
