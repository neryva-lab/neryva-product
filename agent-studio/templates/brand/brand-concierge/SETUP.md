# Setup — brand-concierge

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "brand-concierge" } }` →
   assistant + DRAFT version + install record, atomically.
2. **Connect knowledge:** ingest the `brand-docs` corpus (policies, pricing, FAQs). Provisioning
   reports `knowledge_source_missing` until READY documents exist; replay provisioning after ingest.
3. **Review the draft:** adjust tone slot, banned claims, and disclaimer in instructions; remap
   `allowed_models` to the org catalog if flagged.
4. **Evaluate:** run the 12 shipped cases (`eval/cases.jsonl`) — bar is ≥ 11/12 with 0 critical
   fails — then publish.
5. **Bind channels:** widget plus WhatsApp/Messenger/Telegram/voice per `bindings/channels.json`;
   voice inherits the 2-sentence spoken format.
