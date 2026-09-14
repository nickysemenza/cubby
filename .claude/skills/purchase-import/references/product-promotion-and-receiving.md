# Product promotion and receiving

Automatically promote a receipt line when it identifies a specific durable,
consumable, subscription, or repeatable commodity and carries a defensible
Product cost basis. High-confidence evidence includes an exact vendor-issued
name plus a distinguishing variant, size, finish, or profile even when the
source does not expose a SKU. A generic name or mixed bucket is not sufficient;
present those candidates for a decision instead of silently skipping them.

- Use `generic` manufacturer only when no maker is stated. Dimensions, grade,
  treatment, finish, and profile can identify commodity materials.
- Put manufacturer models in `model`. Put retailer SKU, catalog, internet, or
  item numbers in typed `externalIds`.
- Create a Product with all known fields in one rich `entity create product`
  call (`entity_batch` for a receipt's worth); do not create then patch just to
  set category/model/tags/identifiers. Run `resolve_products` over the line
  names first — it reports exact name/alias hits and near-misses without
  creating anything.
- Bagged or weight-sold produce (a 226 g bag of chilies, meat by the pound):
  keep the Product's `each` meaning ONE piece so a recipe's "3 whole" costs
  three chilies, carry the bag price as an explicit `<weight> = $X` unit
  mapping, and leave that Expense line's `productQuantity` null. A quantity of
  1 there would derive a per-`each` price of the whole bag, and the costing
  engine resolves every product of an ingredient on one shared `each` node —
  three chilies would cost three bags.
- Keep exact-SKU durable Expenses as product candidates even when currently
  unlinked. Conversely, do not force an aggregate Expense onto a Product when
  its individual cost is unknowable.
- Split exact merchandise subtotals automatically as `principal` Expenses and
  keep separately stated shipping, tax, discounts, fees, and tips as typed,
  productless adjustment Expenses. Preserve the literal signed amounts; never
  estimate embedded tax or allocate an ancillary total across Products.
- `misc:` inventory buckets remain product-link ineligible for Expenses.
- Product creation and Expense linking never changes inventory. Always ask
  explicitly before creating or moving Inventory Entries, even when Product
  promotion is automatic; report receiving separately.

For a durable and its consumables, share a compatible tag but attach
maintenance tasks to the durable Product, not its replacement consumable.

## Standing import preferences

Confirmed by the operator across several vendor imports; assume them without
re-asking:

- **Promote every receipt line to a Product**, consumables and sub-dollar items
  included. Low-value rows in the Products table are not a concern.
- **Create provisional FinancialAccounts** whenever the evidence supports a
  truthful identity (statement names the card product, receipt gives the
  tender) rather than leaving settlement unrecorded.
- **Skip card-only spend with no line items** — report it, do not book it.
  Spend is itemized or absent.
- **The project is decided per batch**, never assumed — see
  matching-and-duplicates.md for the "which project was accruing that day" test.
- Perishables and live plants take `stockTracked: false`; accessories the
  operator wants costed but not shelved likewise.
- Groceries are fully in scope: every order booked, every line itemized, a
  Product per line. Apparel is in scope too.

## Sale rows must carry the Product

A sale Expense with `productId: null` is financially correct but leaves the
Product showing an acquisition and no exit, so a later historical backfill
**re-stocks an item that was sold**. Link exits (`productQuantity: −|units|`)
whenever the listing title or Seller Hub identifies the item; a "units bought
vs units sold" group-by per Product then catches phantom sales and re-stocks at
once. Credits booked with a *positive* quantity are invisible to the exits
detector — hunt returned-but-still-stocked items on net spend ≤ 0 with live
inventory, not on quantity signs, and remember a location name is not evidence
of possession when the entry was never verified.

A cancelled order's charge lines take **no `productQuantity`** (the unit never
arrived and must not enter the derived-price sample); a `$0.00` warranty
replacement likewise. A kept partial refund is a price concession and takes
null, not `−1` — a `−1` there reads as a second disposal.

## Kits, packs, and materials

Splitting kits, allocating bundles and BOGO discounts, N-pack/single pairs, and
the three lanes for construction materials leaving "Not on a shelf" are in
[kits-and-bundles.md](kits-and-bundles.md).
