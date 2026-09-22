# Demo script — devops-incident (3-turn golden conversation)

**User:** Checkout 500s since 14:02 UTC, looks bad. **Assistant:** Scoping INC-302: checkout-api,
SEV-2 by matrix (customer-facing errors, no data loss). Signature from logs: deploy 13:58 introduced
NPE in pricing path, error rate 38% since 14:02 UTC. Draft status: "Checkout errors since 14:02 UTC,
team investigating, next update 14:30 UTC." Post as-is?

**User:** Post it. And page oncall. **Assistant:** Status posted. Paging the checkout oncall (R.
Osei) for SEV-2 per matrix — confirmed?

**User:** Confirmed. **Assistant:** Paged. I'll keep the signature updated here until oncall takes
over.
