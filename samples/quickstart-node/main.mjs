/**
 * Neryva quickstart (Node 18+) — FL-3.16 sample app.
 *
 * Run: NERYVA_BASE_URL=... NERYVA_API_KEY=nrv_live_... ASSISTANT_ID=<uuid> node main.mjs
 * (install the SDK from products/sdk/typescript first; this sample imports it relatively)
 */
import { NeryvaClient } from '../../sdk/typescript/src/index.ts';

const baseUrl = process.env.NERYVA_BASE_URL ?? 'http://localhost:3000';
const apiKey = process.env.NERYVA_API_KEY;
const assistantId = process.env.ASSISTANT_ID;

if (!apiKey || !assistantId) {
  console.error('Set NERYVA_API_KEY (nrv_live_...) and ASSISTANT_ID first.');
  process.exit(1);
}

const client = new NeryvaClient({ baseUrl, apiKey });

const conversation = await client.createConversation(assistantId);
console.log('conversation:', conversation.id);

const result = await client.sendMessage(conversation.id, 'Hello! What can you help me with?', {
  idempotencyKey: `quickstart-${Date.now()}`,
});
console.log('run:', result.run_id);

for await (const event of client.streamRunEvents(conversation.id, result.run_id)) {
  if (event.event === 'delta') {
    process.stdout.write(String((event.data)?.text ?? ''));
  } else if (event.event === 'terminal') {
    console.log('\n[terminal]');
  }
}

const page = await client.listMessages(conversation.id);
for (const message of page.messages) {
  console.log(`${message.role}: ${(message.content?.text ?? '').slice(0, 120)}`);
  for (const followup of message.content?.suggested_followups ?? []) {
    console.log(`  suggestion: ${followup}`);
  }
}
