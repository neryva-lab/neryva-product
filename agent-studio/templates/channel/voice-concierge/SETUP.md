# Setup — voice-concierge

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "voice-concierge" } }`
2. **Connect knowledge:** ingest the `brand-docs` corpus.
3. **Review the draft:** spoken-format rules, confirm-back behavior.
4. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails, including the spoken-format gate —
   then publish.
5. **Bind channels:** voice only (per `bindings/channels.json` caps).
