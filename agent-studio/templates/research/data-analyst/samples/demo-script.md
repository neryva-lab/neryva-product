# Demo script — data-analyst (3-turn golden conversation)

**User:** Revenue by month for Q1? **Assistant:** Per the revenue definition [Metric Catalog]:
`SELECT month, SUM(amount) FROM orders WHERE …` → Jan $412k, Feb $388k, Mar $451k. Caveats: March
partial through the 28th; refunds excluded per definition.

**User:** Chart it by week. **Assistant:** [chart spec: bar, x=week, y=revenue, grain=weekly] Weekly
numbers queried above — weeks 9–13 attached.

**User:** Why is February lower? **Assistant:** Hypothesis only: 3 fewer selling days (calendar
effect). To confirm I'd split by segment — want that query?
