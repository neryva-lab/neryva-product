# Neryva Quickstart (Node)

```bash
export NERYVA_BASE_URL=http://localhost:3000
export NERYVA_API_KEY=nrv_live_...
export ASSISTANT_ID=<published assistant uuid>
node main.mjs
```

Creates a conversation, sends a message, streams the run's durable events
(`delta` / `thinking` / `terminal`), then prints the transcript with any
suggested follow-ups.
