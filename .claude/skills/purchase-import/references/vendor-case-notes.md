# Vendor case notes

Use these as reminders to seek evidence, not as rules that override a current
source.

- Amazon exports may repeat refund/return records. Deduplicate events before
  summing and distinguish cancelled orders from fulfilled purchases.
- Marketplace listing exports contain asking prices and listing dates; a
  `Sold` state can include cancellation or cross-listed inventory. Seek actual
  settlement before booking a sale.
- A deposit and balance on one documented vendor order are one Purchase with
  multiple Expenses/Financial Transactions. Progress payments without one
  fixed-scope order remain separate Purchases.
- For line-item splits, allocate tax, shipping, and fees only across the lines
  they actually apply to. Round to cents last and explain any residual cent.
- Never infer that a missing email proves no event without first establishing
  the mailbox/source coverage window.
