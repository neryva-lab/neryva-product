"""Neryva quickstart (Python, stdlib SDK) — FL-3.16 sample app.

Run: NERYVA_BASE_URL=... NERYVA_API_KEY=nrv_live_... ASSISTANT_ID=<uuid> python main.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))

from neryva import NeryvaClient  # noqa: E402

base_url = os.environ.get("NERYVA_BASE_URL", "http://localhost:3000")
api_key = os.environ.get("NERYVA_API_KEY", "")
assistant_id = os.environ.get("ASSISTANT_ID", "")

if not api_key or not assistant_id:
    print("Set NERYVA_API_KEY (nrv_live_...) and ASSISTANT_ID first.", file=sys.stderr)
    sys.exit(1)

client = NeryvaClient(base_url, api_key)

conversation = client.create_conversation(assistant_id)
print("conversation:", conversation.id)

result = client.send_message(
    conversation.id,
    "Hello! What can you help me with?",
    idempotency_key=f"quickstart-{os.getpid()}",
)
print("run:", result.run_id)

if result.run_id:
    for event in client.stream_run_events(conversation.id, result.run_id):
        if event.event == "delta":
            print(str((event.data or {}).get("text", "")), end="", flush=True)
        elif event.event == "terminal":
            print("\n[terminal]")

page = client.list_messages(conversation.id)
for message in page.messages:
    text = (message.get("content") or {}).get("text", "")
    print(f"{message.get('role')}: {text[:120]}")
    for followup in (message.get("content") or {}).get("suggested_followups", []):
        print(f"  suggestion: {followup}")
