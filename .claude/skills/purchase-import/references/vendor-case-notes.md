# Vendor case notes

Use these as reminders to seek evidence, not as rules that override a current
source.

## Amazon

- Amazon exports may repeat refund/return events. Deduplicate the event, not a
  summary total; distinguish cancelled orders from fulfilled purchases and record
  the documented refund destination.
- Treat an ASIN as exact identity only when the purchased variant is confirmed.
  Preserve the receipt-era title in Purchase/Expense evidence; do not replace it
  with a current marketplace SEO title.
- A replacement is not automatically a refund or a new unrelated purchase. Keep
  its documented relationship in notes until a queryable relation is needed.

## Home Depot

- Treat order/return exports as event ledgers: deduplicate repeated aggregate
  refunds before summing and use the final receipt/credit as the money evidence.
- Use the exact Internet SKU as `source: "home-depot"`,
  `kind: "internet_number"`. `Internet SKU` value `0` is unresolved identity,
  not a usable identifier.
- Return quantities remain positive while the Expense cost is negative. Preserve
  source tax/discount rounding and explain any residual rather than redistributing
  it silently.
- Marketplace listing exports contain asking prices and listing dates; a
  `Sold` state can include cancellation or cross-listed inventory. Seek actual
  settlement before booking a sale.
- A deposit and balance on one documented vendor order are one Purchase with
  multiple Expenses/Financial Transactions. Progress payments without one
  fixed-scope order remain separate Purchases.
- For line-item splits, preserve explicitly itemized tax, shipping, discounts,
  and fees as typed productless Expenses. Leave embedded amounts embedded; do
  not allocate or estimate them across merchandise lines.
- Never infer that a missing email proves no event without first establishing
  the mailbox/source coverage window.
