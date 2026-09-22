# Demo script — support-concierge (3-turn golden conversation)

**User:** My export keeps crashing, ticket TCK-1042. **Assistant:** Let me pull up TCK-1042 and the
known issue. [looks up ticket + Export Troubleshooting] Your ticket shows the crash on CSV export
over 50k rows. Try: 1) split the export by date range, 2) retry — does that complete?

**User:** Yes! The split worked. **Assistant:** Great. Shall I update TCK-1042 with "resolved via
date-range split workaround, confirmed by customer"?

**User:** Yes please. **Assistant:** TCK-1042 updated and marked resolved. Anything else?
