# Setup — support-concierge

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "support-concierge" } }`
2. **Connect tools:** create `search_tickets` + `update_ticket` catalog rows (update approval
   REQUIRED); replay provisioning after adding them.
3. **Connect knowledge:** ingest the `help-center` corpus.
4. **Review the draft:** severity thresholds, banned claims, disclaimer text.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget + messaging (no voice; troubleshooting needs text).
