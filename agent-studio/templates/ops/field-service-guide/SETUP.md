# Setup — field-service-guide

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "field-service-guide" } }`
2. **Connect tools:** create `generate_quote` + `create_meeting` catalog rows (both approval
   REQUIRED); replay provisioning after adding them.
3. **Connect knowledge:** ingest the `service-price-book` corpus.
4. **Review the draft:** scope honesty, disclaimers, validity window.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget + WhatsApp (techs work by chat on site).
