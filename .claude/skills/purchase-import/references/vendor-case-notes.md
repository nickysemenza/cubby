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
- The Purchase History CSV export (cp1252, header at `Date,Store Number`) is
  cheaper than the order pages but is not authoritative. Its two price columns
  are swapped — `Extended Retail (before discount)` is the amount actually paid
  and `Net Unit Price` is pre-discount list, verifiable by
  `net - discount == ext` — and that paid column is *extended* on most orders,
  *unit* on some multi-quantity rows, and *tax-inclusive* on others. It also
  keeps cancelled lines that the order page excludes from its subtotal, and it
  never states sales tax at all. Reconcile each order against the order page's
  stated total and prefer that page whenever the two disagree.
- Its `Department Name` is not a line role: `FEES` contains real merchandise
  (thinset mortar) alongside genuine charges. Classify adjustments by
  description — `Outside Delivery`, `CURBSIDE DELIVERY SERVICE`, `CA LUMBER FEE`,
  `PAINTCARE FEE` — never by department.
- A kit line lists its bundled components as extra `$0.00` rows sharing the kit's
  internet number. Book the kit once at its own price and drop those rows;
  promote the components as Products with no cost basis rather than inventing a
  per-component allocation.
- Orders rung up without the Pro Xtra account never appear in the export at all,
  so absence there is not evidence a purchase did not happen.
- A return is an exit: the Expense cost is negative and its `productQuantity` is
  negative too, `−|units returned|`. Preserve source tax/discount rounding and
  explain any residual rather than redistributing it silently.
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
- The CSV importer also wrote `costType: "materials"` for nearly every row
  regardless of item — as of 2026-08 that is 603 of 633 rows carrying the
  `Imported from Home Depot purchase-history CSV` note, tool boxes and power
  tools included, while `trade` was assigned sensibly. Treat `materials` on a
  CSV-imported row as unverified rather than as a human classification, and
  reclassify obvious tools when touching one. The remainder is a worklist, not
  settled data.
- `homedepot.com` returns 403 to WebFetch and curl; reach product pages through
  the signed-in browser instead. `homedepot.com/s/<MODEL>` redirects straight to
  the page on an exact model match, otherwise scroll the lazy results grid before
  reading links — the links readable before scrolling are typeahead
  recommendations, not results. A kit's per-component model numbers live in the
  `Includes:` bullets under the collapsed **Product Details** accordion, which
  must actually be clicked; page text alone will look like the data is absent.
  RYOBI is HD-exclusive, so `ryobitools.com` product ids *are* HD internet
  numbers when HD's own search is unhelpful.

## McMaster-Carr

- Documents are titled `Receipt` (a paid invoice, carrying its own `Invoice`
  number, `Paid`, packing list and tracking) or `Credit` (a credit memo naming
  the invoice and packing list it reverses). File them `receipt` and
  `credit_memo`. The customer-set `Purchase Order` string is a label, not the
  order id — use the invoice number; receipts often note that the PO was renamed
  mid-order, which is worth keeping in Purchase notes.
- Every receipt separates `Merchandise`, `Sales Tax`, and `Shipping`, so the
  split is fully evidenced — never allocate shipping or tax across lines.
- **The printed part number is sometimes a family number, not a unique SKU.**
  One receipt listed `7715T31` three times for black-50 ft, white-50 ft, and
  green-25 ft wire, and `6642T6` twice for coveralls in M and XL. The vendor's
  own line text carries the distinguishing variant, so these are separate
  Products; do not collapse them, and do not attach the shared number to each as
  a `retailer_sku` external ID — that asserts a uniqueness the vendor does not.
  Record it in notes instead. Genuinely unique numbers go in `externalIds` as
  `source: "mcmaster"`, `kind: "retailer_sku"`, with `https://www.mcmaster.com/<part>/`.
- Items are house-brand or unattributed; the receipt names no manufacturer. Use
  `generic` rather than inventing one, and leave `model` unset — McMaster part
  numbers are retailer identifiers, not maker models.
- A credit memo keeps the original line numbers (1, 3, 4, 6) rather than
  renumbering, which makes partial returns easy to tie back line-for-line.

## Golden State Lumber

- Two document shapes. A `Delivered Order` carries `Order No` and is a deposit
  receipt; a `Cash Sales Invoice` carries `Invoice No` plus a separate
  `Order Reference`. Record the number the document leads with, and keep the
  other in notes.
- Tax bases, verified across several orders — do not "correct" them: sales tax
  applies to the **full** subtotal including delivery, while the 1% CA lumber
  products assessment applies to wood lines only, delivery exempt. Not every wood
  line is assessable (primed pine casing was not; cedar and Doug fir were). Book
  the LPA as a `fee`, not a `tax`.
- A partial cancellation appears as a next-day credit on the card, not a revised
  document. The deposit receipt on file stays at the pre-cancellation figure, so
  `statedTotal` legitimately exceeds the Expense total. Do not close that gap.

## Muller Construction Supply

- Invoices are numbered `C#####/2`; the bare digits are the order number
  (`C02791/2` ↔ order 202791). Returns get their own `CASH REFUND` document,
  `C#####/2` again, printed with the originating invoice number on every line.
- A refund Purchase can never satisfy `primary_document` — a credit memo is not
  a primary kind and no invoice was ever issued for a return. Record
  `not_issued` rather than leaving the gap open or mistyping the credit memo.
- Fully-returned lines still belong on the original invoice for fidelity, but
  leave them productless: a line returned in full has no net cost basis.

## Bay Metals

- Frequently paid in cash — the stapled register tape shows tendered and change.
  When it does, no card row exists at all; confirm the negative against the card
  exports over a window that contains the vendor's *other* charges, then record
  `settlement_reference` as `not_applicable`.
- Item codes encode the profile (`ST11214` = square tube 1-1/2 × 1-1/2 × 14 ga
  × 20 ft; `FB18112` = flat bar 1/8 × 1-1/2 × 20 ft). Near-twins differing only
  in width or gauge are separate Products — say so in each Product's notes so a
  later dedup pass does not merge them.
- Cutting is a separate, non-taxable service line. It carries no allocated tax
  and never a Product.

## Central Builders Supply

- Handwritten, unnumbered pad. The **stapled register tape is authoritative** for
  amounts, quantities, unit prices and department, even when the handwritten body
  is illegible — book from the tape and describe from the body.
- The `ORDER`/`SHIP` columns use foot ticks (`20'`, `5'`) to mean linear feet
  rather than pieces. Missing that turns 5 ft of copper into 5 fittings.
- Ledger rows for this vendor may be hand-entered approximations. One sat at a
  round $100.00 against a real $127.91 charge for a year. The receipt supersedes
  the round number; correct it and say so.

## California Marble & Stone

- Numbers nothing: the proposal contract, the final invoice and the `INVOICE #`
  field are all blank. Identify documents by date and record `order_id` as
  `not_issued`.
- The deposit and the balance currently sit as two Purchases, each with
  `statedTotal` equal to its own payment rather than the contract sum. That is a
  real tension with the general rule that one fixed-scope order is one Purchase —
  the contract *is* fixed-scope. Leave the existing shape alone unless the user
  asks; do not merge them silently, and do not set either `statedTotal` to the
  full contract value.

## Weee!

- Order pages (`weee.com/en/order/detail/<id>`) need the logged-in browser. The
  page text lists every line as `<title> / Item price: $x |Qty: n / $ext`, then
  `Subtotal`, `Coupon`, `Taxes` (always $0 — grocery), `Service fee`, `Delivery
  fee`, `Guaranteed delivery`, `Tip`, `WeeeCash Applied`, `Payment total`,
  `Order total`, `Payment method`, `Refunded amount`. Book the coupon as
  `discount`, guaranteed delivery as `fee`, tip as `tip`.
- Product images are on the page but hydrate late: query
  `[data-testid="wid-order-detail-product-image"]` after ~2.5 s. `alt` is
  `weee_<listing title>`; the `src` ends in `!c152x152_q80.auto` — strip from
  `!` for the 1200–1350 px original, which needs no auth and attaches by url.
  No product ids or links are exposed on the order page; the public
  `weee.com/en/search?keyword=…` (no login) gives result cards with the same
  CDN image and the numeric product id in the `/product/<slug>/<id>` href —
  record that id as a `weee` / `retailer_sku` external id.
- **Refunds for missing items are NOT card credits.** They land as WeeeCash
  wallet balance and are spent as `WeeeCash Applied -$x` tender on a later
  order; `Order total ≠ Payment total` is the tell. Model the wallet as one
  `stored_value` FinancialAccount, book the refund as a negative `principal`
  line (`productQuantity: -1`) plus a `refund` transaction on the wallet, and
  the later spend as a `purchase` transaction on the wallet beside the card's.
- Card descriptors: Monarch `WEEE INC.`, Copilot `Weee Inc` and `Grocery Weee!`.
- Listing titles drift over the years for one SKU (`LKK Soy Sauce 500ml` →
  `Lee Kum Kee Premium Soy Sauce 500 ml`, Aroy-D `13oz` → `14 oz` for the same
  400 ml can). Alias the product with the older title rather than minting a
  twin, and say so in the Expense note.
- Older orders (2021) can freeze the browser renderer so every scripting tool
  times out and sibling weee.com tabs hang with it. Have the operator copy the
  page text and paste it; images then come from the public search above.

