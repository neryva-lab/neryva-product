# Setup — personal-aide

1. **Install:** `POST /console/org/:orgId/assistants { name, template: { slug: "personal-aide" } }`
2. **Connect tools:** create `schedule_meeting` + `send_email` catalog rows (approval REQUIRED);
   provisioning reports `required_tool_missing` until ENABLED rows exist — replay provisioning after
   adding them.
3. **Review the draft:** narrow `user-docs` ACL expectations, confirm the PII-minimization posture,
   remap models if flagged.
4. **Evaluate:** run the 10 shipped cases — bar is ≥ 9/10 with 0 critical fails — then publish.
5. **Bind channels:** widget/chat only (no broadcast channels).
