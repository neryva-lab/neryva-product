# Neryva Quickstart (Python)

```bash
export NERYVA_BASE_URL=http://localhost:3000
export NERYVA_API_KEY=nrv_live_...
export ASSISTANT_ID=<published assistant uuid>
python main.py
```

Same flow as the Node quickstart: conversation -> message -> durable event
stream -> transcript with follow-ups. Uses the stdlib-only `neryva` SDK.
