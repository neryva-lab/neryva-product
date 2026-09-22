# neryva (Python SDK)

Typed, stdlib-only client over the Neryva L2 conversation plane (`/v1/*`).
Authenticate with a `nrv_live_` API key from the Neryva console.

```python
from neryva import NeryvaClient

client = NeryvaClient("https://engine.example.com", "nrv_live_...")

conversation = client.create_conversation("<assistant-uuid>")
result = client.send_message(conversation.id, "Hello!", idempotency_key="msg-1")
for event in client.stream_run_events(conversation.id, result.run_id):
    print(event.event, event.data)   # delta | thinking | terminal | ...
page = client.list_messages(conversation.id)
```

Retries: `send_message` is idempotent under `idempotency_key` — a retry after
a lost response returns the ORIGINAL message, never a duplicate. SSE
reconnection: pass the last seen `engine_sequence` as `last_event_id`.
