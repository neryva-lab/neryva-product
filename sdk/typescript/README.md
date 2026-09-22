# @neryva/sdk (TypeScript)

Dependency-free client over the Neryva L2 conversation plane (`/v1/*`).
Authenticate with a `nrv_live_` API key from the Neryva console.

```ts
import { NeryvaClient } from '@neryva/sdk';

const client = new NeryvaClient({ baseUrl: 'https://engine.example.com', apiKey: 'nrv_live_...' });

const conversation = await client.createConversation('<assistant-uuid>');
const result = await client.sendMessage(conversation.id, 'Hello!', { idempotencyKey: 'msg-1' });
for await (const event of client.streamRunEvents(conversation.id, result.run_id!)) {
  console.log(event.event, event.data); // delta | thinking | terminal | ...
}
const page = await client.listMessages(conversation.id);
```

Retries: `sendMessage` is idempotent under `idempotencyKey` — a retry after a
lost response returns the ORIGINAL message, never a duplicate. SSE
reconnection: pass the last seen `engine_sequence` as `lastEventId`.
