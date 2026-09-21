# Vendor case notes

Read only the section for the current vendor. These are source-navigation and
interpretation notes, not household history or rules that override current
evidence. Examples are synthetic; resolve account, project, and entity references
from the live authorized workflow.

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
- A legacy CSV importer may assign `costType: "materials"` indiscriminately.
  Treat imported classifications as unverified and reclassify only from source
  evidence when touching a row; do not treat importer defaults as human choices.
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
  A family number can span several colours, lengths, or garment sizes. Use
  the vendor line text to distinguish variants; do not attach a shared family
  number as a unique `retailer_sku` on several Products. Record it in notes instead. Genuinely unique numbers go in `externalIds` as
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
- Check the printed tax bases rather than recomputing them: sales tax
  applies to the **full** subtotal including delivery, while the 1% CA lumber
  products assessment applies to wood lines only, delivery exempt. Not every wood
  line is assessable (primed pine casing was not; cedar and Doug fir were). Book
  the LPA as a `fee`, not a `tax`.
- A partial cancellation appears as a next-day credit on the card, not a revised
  document. The deposit receipt on file stays at the pre-cancellation figure, so
  `statedTotal` legitimately exceeds the Expense total. Do not close that gap.

## Muller Construction Supply

- Invoices are numbered `C#####/2`; the bare digits are the order number
  (`C#####/2` ↔ the corresponding order digits). Returns get their own `CASH REFUND` document,
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
- Ledger rows may be hand-entered approximations. The itemized receipt
  supersedes a rounded estimate; correct it with the evidence recorded.

## California Marble & Stone

- Numbers nothing: the proposal contract, the final invoice and the `INVOICE #`
  field are all blank. Identify documents by date and record `order_id` as
  `not_issued`.
- When legacy records split a fixed-scope contract into deposit and balance
  Purchases, do not silently merge them or set each payment to the full contract
  value. Reconcile the documented scope and obtain the required merge approval.

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
- Listing titles can change for one SKU. Confirm the variant and package
  quantity, then retain an older title as an alias rather than minting a twin.
- Older order pages can freeze the browser renderer so every scripting tool
  times out and sibling weee.com tabs hang with it. Have the operator copy the
  page text and paste it; images then come from the public search above.


## Amazon — export semantics

- `Order History.csv` (personal-data export): **`Total Amount` is the per-line
  extended total**, tax-inclusive and net of discounts (`Unit Price × Qty + Unit
  Price Tax × Qty − Total Discounts`; `Unit Price Tax` is per unit). **`Shipment
  Item Subtotal` is a shipment-level figure repeated on every line** — never a
  line amount. Discounts arrive Excel-quoted (`'-3.9'`). `Website = panda01` is
  Amazon Fresh / Whole Foods grocery; nothing else is. `_ASINLESS_` is a sentinel
  for loose produce, not an ASIN — keying on it collapses hundreds of lines onto
  one Product. Exclude `Order Status = Cancelled` lines.
- `Refund Details.csv` lists the same refund several times under different
  reversal events. Dedupe on (order, amount, date-to-the-minute), then also
  **refuse any refund that would push an order's refunds above its spend** —
  that catches the duplicates the timestamps miss. `Customer return` is a
  disposal (`productQuantity: -1`); `Account adjustment` is a price concession
  on a kept item (`productQuantity: null`).
- **Backfilling from the order file without the refund file creates phantom
  spend.** Cross-check every backfilled order against refunds before booking;
  fully-refunded orders are goods never owned.
- The ASIN column is free identity for every line — never scrape for ASINs.
- **Refunds can settle to gift-card balance instead of the card.** A missing
  card credit alone never proves money is owed. The
  destination is proven per row from the `return@amazon.com` final notice
  ("available now in your Amazon Account" = the stored-value account; card
  wording = the card); never inferred from the base rate. Model the balance as
  one `stored_value` FinancialAccount and extend it.
- A third tender exists: **Shop with Points**. A `$0.00` invoice Grand Total
  with a `Rewards Points: -$X` line (and no `Gift Card Amount` line) is a paid,
  shipped order, not a cancellation; points can also split with the card.
- **Amazon bills per shipment**, and `Amazon Tips*` is a separate charge against
  the same order id that is *not* in `statedTotal` (book it as a `lineKind: "tip"`
  Expense dated to the purchase, after checking for an existing tip row). A
  settlement above the stated total on a tipped order is not over-attachment.
- Two order surfaces disagree. The printable invoice
  (`/gp/css/summary/print.html?orderID=`) exposes `Gift Card Amount` and a
  `Grand Total` that is the *card-charged remainder* (order total = gift +
  grand) plus `Sold by:` per line — the strongest single source for
  charge→order questions. But for a **Whole Foods** trip it omits the savings
  line and reports the pre-discount subtotal as Grand Total; take Whole Foods
  totals from `/your-orders/order-details` and book the savings as one
  order-level `discount`. `/fopo/order-details?orderID=` is the surface that
  carries `/dp/` links and images for in-store scale items; Amazon Fresh
  (`112-`) orders link produce ASINs on the ordinary details page.
- A Product often needs **two ASINs** (Whole Foods storefront id and Amazon
  Fresh id). A Product may hold several `amazon/asin` slots: add the second
  with `patch_products_external_ids` `upsert` and `isPrimary: false` — the
  existing primary survives. Do not use `legacy_unspecified` for a known ASIN.
  Verify all source identifiers after a merge and restore any confirmed missing
  slot through the supported write path. A collision on another Product may
  indicate a duplicate; a missing ASIN match does not prove the Product is new.
  Search the generic noun and inspect alternate storefront identifiers first.
- **Scraping the current-order surfaces from the Chrome tool.** Use
  [amazon-print-extract.js](amazon-print-extract.js) verbatim on each
  printable invoice: it dumps `ORDER / PAY / summary / STATUS / LINES` into a
  `<pre>` for `get_page_text`, because the JS tool truncates its own return at
  ~1,000 characters and blocks any in-page `fetch()` whose URL carries a query
  string. So the loop is `navigate` → `javascript_tool` → `get_page_text`,
  three calls per order, and the order list is paged by navigating
  `/your-orders/orders?timeFilter=months-3&startIndex=N` (10 per page) and
  reading `.order-card` text. A `111-` order prefix is ordinary retail;
  `112-` is Fresh (details page redirects to `/uff/` and hides lines past five
  behind "View all items" — the print page lists them all); `113-` is Whole
  Foods, both in-store trips and shipped marketplace orders.
- Resolve project and cost classification from the authorized import context;
  never copy household-specific assignments from examples. Preserve the source
  labels for tax, bag/deposit fees, tips, and discounts. Do not count savings
  twice when the invoice already nets them into line prices. Check whether a
  driver tip is included in the printed total before treating it as extra.
  Weight-priced goods use `productQuantity: null`; explicit `Each` or `Bunch`
  lines use the documented count. A no-charge replacement keeps its documented
  relationship to the original order and does not imply another received unit.
- Amazon may print a payment token (`Visa *NNNN`) that matches no real card; the
  statement row names the real one. Never mint an account for it.
- `/cpe/yourpayments/transactions` is the charge→order ledger and the only
  arbiter for multi-charge settlement (see financial-settlement.md). Paging it
  is a POST of the `ppw-widgetState` hidden input plus the button whose name
  contains `DefaultNextPageNavigationEvent`; assert on distinct-order growth,
  not row count, before looping.
- The `Your Orders.Returns` CSV covers only the trailing year; the eBay
  `OrdersReport` CSV in the same dump is a *seller* report, not purchases.

## Home Depot — order surfaces and settlement

- **The order-details page is unit-priced** (`Qty: N` beside the price of one
  unit); the CSV's paid column is usually extended. Always check
  `Σ unit × qty = printed subtotal`. Each line's anchor is
  `/p/<slug>-<model>/<internet_number>`, so models and internet numbers come
  free. The rendered page **hides line discounts**; when lines overshoot the
  subtotal, read `window.orderDetailsCache.data.fulfillmentGroups[].lineItems[]`
  (`pretaxTotal` is net of discount, `taxAmount` is per line, `omsId` is the
  internet number, `data.POJobName` is the operator's job tag). Book discounts
  netted into the principal line; do not manufacture a discount row.
- **`View Charge History`** (a button; render it with a `querySelector` click,
  it lands at the end of `body.innerText`) is authoritative for money: every
  charge/refund leg with date, tender and amount, plus `Original Total` /
  `Refund Total` / `Adjusted Total`. `statedTotal` = **Original Total**, not the
  header total, which drops cancelled lines. Cancelled items are charged and
  refunded the same day — book them as buy/cancel pairs so positive lines still
  sum to Original Total. Charge History errors on some orders and predates
  others; the statement exports usually recover those legs. When the order page
  and Charge History disagree, believe Charge History.
- **In-store receipts have an order-details page too**: `orderNumber=<reg>-<txn>`
  plus `salesDate`, `storeNumber`, `transactionId`, `registerNumber` (no leading
  zeros) and `transactionType=S` — all six params required. `View Receipt`
  renders the full receipt as selectable text (per-SKU lines, named promotions,
  masked tender) but no fetchable PDF. Returns use the same URL with
  `transactionType=R`. A synthetic `txn:<date>/<store>/<n>` key from an old CSV
  import maps to a real receipt number: `<n>` is the receipt's second segment
  truncated to its first four digits.
- `/myaccount/purchase-history` → **Table View** with the year / "Last 7 Years"
  presets lists order #, date, tender and total for every order (returns as
  separate negative rows; re-bills as extra pairs) — the whole `statedTotal`
  backlog in one scrape, and the only way to prove an order does *not* exist.
  Take the largest positive row as Original Total; a single collapsed row on a
  partially-cancelled order is the post-cancellation figure. Drive pagination
  with `button[aria-label="Skip to Next Page"]`; the custom date inputs reject
  typed dates. `/order/view/purchasehistory` is a dead route.
- **Rate limiting is session-scoped**: after ~40 rapid order-page loads every
  request errors and waiting does not help — open a fresh tab on `homedepot.com`
  first. Pace Charge History pulls to 3–4 per batch.
- **Tender traps.** The `Payment:` strip lists masks, not amounts, and a
  gift-card mask (`GR - NNNN`) differs between the header and Charge History.
  Apple Pay device numbers (`AX - NNNN`, `VI - NNNN`) print on receipts and order
  pages instead of the card — one card has several — so **never mint a
  FinancialAccount for a last-four printed by the vendor**; map to the statement
  row. A round-number settlement gap on an HD order is a gift card or store
  credit, modelled as a `stored_value` account (the amount is the residual; HD
  never publishes per-tender amounts). Store-credit balances chain across
  receipts and can close several purchases at once. Orders bill **per
  shipment**; a store-fulfilled leg of an online order posts under the store
  descriptor. A discount can post as a separate credit two days later. Refunds
  from several orders returned in one visit post as one card credit, grouped
  by card, not by visit.
- **A `$0.00` history-table total is a same-day-cancelled order** — real
  charge/refund legs, goods never received. Book `— cancelled` credit pairs and
  set `statedTotal` to the vendor's `$0.00`. A CSV row with `Quantity 0` and
  zeroed store/transaction/register fields is the same cancellation and must not
  be created as a missing order.
- A refund receipt's `RECALL AMOUNT` is a free audit of how the original lines
  were priced. A multi-order return receipt prints its refund split by tender,
  and its per-item `ORDER` headings can be rotated by one — trust contents,
  dates and amounts over the labels. A negative receipt total may be a
  multi-order return visit whose credits are already booked individually; do not
  copy it onto one purchase.
- Garden-heavy receipts legitimately run well under the local tax rate (CA
  exempts edible plants) — read the receipt rather than rejecting the remainder.
  HD rounds tax per line, so `subtotal × rate` is a cent or two off; rank
  candidates by arithmetic, confirm on the page.
- When a Purchase reads `mismatch`, **check `statedTotal` against the order page
  before hunting for a missing tax line or unbooked refund** — the stored total
  is usually some other number from the same order (pre-tax subtotal, one line's
  price, the refund sign-flipped). Order dates are wrong on the same rows often
  enough to check too; the cheap detector is a charge posted more than a week
  before its purchase date.
- For finding the order id of a hand-entered aggregate, search Gmail
  `from:order.homedepot.com subject:received "<amount>"` in a tight window;
  `order-details?orderNumber=` resolves ids years older than the history preset.
  Then try writing the id: `PURCHASE_MERGE_ORDER_COLLISION` is the duplicate
  detector. Assume a no-orderId HD aggregate is a duplicate until the collision
  check says otherwise — but a collision is not an equal-value duplicate, so
  rebuild lines from the order page before deleting the lump.
- `homedepot.com/p/<internet#>` 403s the server; in Chrome, the kit contents sit
  in the served markup even while the accordion is collapsed —
  `document.documentElement.innerHTML.match(/Includes[^<"]{0,400}/gi)`. HD names
  battery models in a kit but publishes no model for a bundled charger; a blank
  charger model is a real gap. `ryobitools.com` product ids are HD internet
  numbers, and the ryobitools URL's numeric segment is the product's UPC minus
  its leading zero. Kit-packed tools are the non-`B` model; the standalone
  retail SKU is the `B` variant.

## Lowe's

- The **order-confirmation email** itemizes every line with item number, model,
  unit price and quantity — better than the eReceipt, which has no models. Check
  for a later "Order Change" email before treating composition as final.
- In-store trips generate no email; MyLowe's eReceipts are the recoverable source.
  Orphan in-store charges before the first modelled purchase are backlog, not
  defects.
- Refund evidence: a hand-entered "returns" credit can be the exact sum of two
  already-itemized, already-settled refunds — an instance of the hand-row
  duplicate on the refund side.
- `settled = 0` does not mean unsettled: a fully returned order is a
  charge+refund pair netting to zero. Count allocations, don't sum them.
- Receipt abbreviations misread plausibly: `KIT/BTH` = kitchen/bath, `RFLL` =
  refill, `CVS DC` = canvas drop cloth, `SB PRO` = SandBlaster Pro, `BH` = Blue
  Hawk, a `#` after a number is a grit. The receipt's material word can simply
  be wrong. Names drift between receipt and listing; trust the item number.
- **Blue Hawk was folded into Project Source in place, under the same item
  number.** Set `manufacturer` to the current brand, keep the receipt brand as
  an alias, and say so in notes.
- Item lookup: `lowes.com/search?searchTerm=<item#>` 302s to the product page
  when live; confirm `Item #` in the page text — a search result being present
  does not mean the SKU is live, and the page will happily offer a same-spec
  different SKU. **The rate limit is per browser**: the in-app browser blocks
  hard after ~16 fetches for the session; Claude-in-Chrome was never blocked.
  Use Chrome first for Lowe's. The image CDN (`mobileimages.lowes.com`) keeps
  serving after a block, so capture every ld+json `contentUrl` in the first
  sweep. Home Depot is the fallback for national-brand images only — not for
  house brands, brands HD does not carry, or singles HD sells only as multipacks.

## eBay

- **Sales are booked at order earnings, never item price** (see
  financial-settlement.md, Sale proceeds). `sellingHistory.html` in the
  personal-data export carries gross item + shipping with cancelled orders
  indistinguishable and no order ids — **never bulk-import it**; use it as a
  discovery index only. The settlement-grade sell-side source is the Seller Hub
  transaction report (one year per report; set both dates explicitly or you get
  a one-day report), netted **per order number across all row types** — a
  cancelled sale still produces a positive `Order` row with an offsetting
  `Refund` a day later. Sales before an account's managed-payments coverage may settle through
  PayPal without an eBay transaction record; where only gross evidence exists,
  mark the gross basis explicitly in the note. The PayPal processing cut on those is
  unrecoverable — do not estimate it into a row.
- Pre-managed-payments sales from Gmail: searching the bare item number finds
  the listing, sale, PayPal and feedback threads at once. Principal at gross
  including shipping (`productQuantity: -1`); the shipping label from the
  "eBay Inc Shipping" PayPal receipt as a positive `shipping` line on the sale
  Purchase; the **monthly seller-fee invoice on its own Purchase dated the
  debit date**, never as a line on a sale. A monthly invoice equal to exactly
  10% of one sale's buyer-paid total belongs to that sale — record it as an
  inference. A sale Purchase trips `paperwork_mismatch` permanently (positive
  `statedTotal`, negative Expenses) and older sales may have no modern order id.
- "You made the sale" emails **truncate the listing title**, which silently
  costs the Product link. `ebay.com/sh/ord/?filter=status:ALL_ORDERS` renders
  every order with the full title, item id, order number and status
  (`Canceled` + `$0.00`); `ebay.com/mye/myebay/purchase` gives buy-side order
  numbers. `ebay.com/mes/transactionlist?sh=true` renders the live settlement
  ledger (~90 days) with a running balance and shows which orders a payout
  covered — prefer it to generating a report for recent sales.
- **A payout is never per-order earnings**: a label bought against an open
  payout is netted from a *later* payout than its order's, and no separate
  charge exists. Allocations must share the payout's sign, so such a clawback
  cannot be split out — leave the gap and explain it in the note.
- Export quirks: tables are malformed HTML (parse the flat `<td>` list in
  fixed-width chunks); `paymentOrderInfo.html` is the only settlement-grade buy
  source, and its `txnId` derives the order id exactly once zero-padded to 15
  digits (`d[0:2]-d[5:10]-d[10:15]`); `purchaseHistory.html` `totalPrice`
  excludes shipping and tax; `EBAY_BALANCE` payments to deleted/system
  counterparties are seller shipping labels already inside net earnings —
  booking them double-counts. A username ending `@Deleted` on a sale is a
  non-paying bidder; only a "You've been paid!" email proves payment.
- Cancelled sales are relisted under a new item id, so the same goods appear
  twice. A "units bought vs units sold" group-by per Product catches phantom
  sales at once — which only works when sale rows carry a `productId`.

## B&H Photo

- The order-history page is a SPA whose hash URL does not drive it — drive the
  year dropdown and read per year; the JSON API behind it cannot be called from
  the browser tool (query strings are blocked). Detail pages carry per-line
  unit prices, payment method (split tender with gift cards appears only here)
  and ship-to.
- Kits: a **B&H KIT** (SKU suffix `J`) is one priced parent plus `KIT ITEM`
  rows with no price — composition stated, component value never; a
  manufacturer kit is one priced row with no children; free bundled extras are
  `$0.00` top-level rows. Multi-package orders show only the order total. Do not
  go looking for line prices the source does not have. "EN-EL14/15" batteries on
  a B&H order are usually Watson (the house brand), not Nikon.
- A vendor whose history was never pulled is the usual reason an exit looks
  untraceable — "purchase predates ledger coverage" is a hypothesis, and a
  "do not re-flag" note is only as good as the reason it states.

## Zappos

- `zappos.com/orders` has no pagination beyond the first page; the list page
  renders only the expanded order in `<article>`, so scan `body.innerText`. The
  detail page is the whole primary source (per-item price, ASIN, colour, size,
  return status, each credit with its date).
- **The list page's Total is the NET after returns**, not the order total —
  `statedTotal` comes from the detail page. Returns can materially change the list total; only kept pairs become Products. Zappos **charges per
  shipment**, and one charge can span two items.
- A "Refund Issued" item with no credit line and a `$0.00` re-shipment of the
  same ASIN two days later is a **replacement**, not a refund: keep the Product
  link and `+1` on the paid line and leave the `$0.00` line unlinked.
- Refund credits combine item price and tax and often cover several pairs —
  one `other_adjustment` row each. Tax rate varies by ship-to address and era.
- One ASIN per size/colour; two sizes of one shoe are two Products. ASINs
  sighted on Zappos pages are recorded `source: "zappos", kind: "asin"`, not
  `amazon` — they are not verified to resolve on amazon.com.

## IKEA

- `ikea.com/us/en/purchases/` is the only complete source; Gmail has
  home-delivery confirmations only. Purchase ids are 9-digit order numbers
  (delivery) or long receipt numbers (in-store); lines past ten hide behind
  "Show more". The page is a fragile SPA — one clean load, one expansion pass,
  then read; repeated clicks blank it.
- **Delivery-order pages under-report money** (`Tax $0.00`, pre-tax Total);
  trust the confirmation email for those. In-store pages state tax correctly.
- Article numbers come from product-page links (`/p/<slug>-<8 digits>/`, split
  3-3-2), colours from image filenames — often the only way to learn the variant
  on an in-store receipt. Link anchors sit outside the product card; join by the
  image filename's leading slug. `?f=xl` gives a bigger image and the server
  fetches ikea.com fine.
- Old card-only IKEA charges with no purchase-history line are report-only:
  spend is itemized or not booked.

## Apple (direct)

- Two billing streams: hardware from `orders.apple.com` / `store.apple.com`
  senders with `W`-prefixed order ids (refurbished included, identifiable only
  by "Refurbished" in the line); App Store / iCloud receipts from
  `no_reply@email.apple.com` with `MM9`-prefixed ids are not hardware. Filter
  by sender domain.
- Trade-ins are negative principal on the outgoing Product (`productQuantity:
  -1`), dated to the refund when credited later.
- `statedTotal` is Apple's literal `orderTotalLabel`, which is tax-inclusive on
  a plain order but **merchandise only** on any installment or trade-in order —
  those Purchases read `mismatch` by design; explain in notes, do not edit
  Expenses.
- A generic "processing a refund" email from `order_update_us@` fires for
  lost-shipment investigations too and states no amount; the later
  `payment@apple.com` message carries the real figure (it can be shipping
  only). Delivery proof: an iCloud sign-in naming the device model, or a
  "Personal Setup" invite carrying the order number.
- AppleCare is `costType: services` principal, not a Product.
- Identity: A-numbers for devices (US variant), Model Identifiers for
  configure-to-order Macs, `Mxxxx/A` part numbers for accessories (prefer the
  part number for AirPods — A-numbers name the buds and case separately). Apple
  part numbers are **per colour** and the product page defaults to one variant;
  select the swatch before reading Manufacturer Information. Apple's store CDN
  binds its resize token to the requested size, so image URLs cannot be
  upscaled.
- Apple purchases may be entirely absent from the statement ledger; that is a
  statement-import gap, not a matcher problem.

## Acme Tools

- A browser-saved `Order History.html` is complete and parseable. Slice order
  blocks on `data-order-id` positions — order ids can carry a `-000S` suffix,
  so a `order-\d+` class regex silently drops orders. `order-product-price` is
  **extended**. `data-pid` is a 12-digit UPC for most items or an internal
  `S0…` code. Saved thumbnails are 100 px — not cover material.
- A trailing `F` on a Milwaukee SKU is Acme's promotional/free-item SKU for the
  same maker model: keep it as an `acme-tools` / `retailer_sku` external id,
  `model` stays the base number, and the line books at `$0.00` (free, not
  missing spend).
- `acmetools.com` 403s curl and throws a PerimeterX "Press & Hold" challenge
  after one or two navigations; while a page loads it carries excellent JSON-LD
  (`gtin` zero-padded to 13 — store the 12-digit UPC-A). Milwaukee and Festool
  sites are curl-friendly; Milwaukee publishes no UPC.
- The order-history page shows line prices and the grand total only; per-line
  promos can sum differently from the invoice's discount line. Get the invoice
  before booking a discount row.

## Direct Tools Factory Outlet

- **`$0.00` replacement orders must not be booked**: a short shipment spawns a
  new order number containing the undelivered lines at `$0.00` with no payment
  block. Booking it double-counts.
- `-NNNN_S` suffixed orders are **separate purchases** (different SKUs,
  charged separately), each its own `orderId` and Purchase.
- `SHIPPING` often renders as the literal placeholder `_ _` when free — do not
  record a figure you did not read. `ZR`-prefixed SKUs are factory
  reconditioned; `VN`/`VNM` suffixes are outlet variants with no page of their
  own. Combo-kit receipts show only the kit SKU, never the contents.

## Penn State Industries

- The order-status page resolves from the order number alone when signed in
  and restates lines, item numbers, shipping, tax, total and payment method.
  `javascript_tool` is blocked on these query-string pages; `get_page_text` and
  `read_page` work. Product pages' `og:image` is the canonical shot (some sit in
  a numbered subdirectory — read the tag, do not construct the path). House
  brands are "Penn State Industries" (`CUG`/`PK` prefixes) and "Benjamin's Best";
  third-party makers appear only in the listing body. Item numbers go in
  `penn-state-industries` / `item_number`.

## SIDIO (Shopify account)

- The vendor decomposes its own bundles: an order renders a priced parent plus
  components at `$0.00`, each carrying a `SIMPLE BUNDLES: <parent> | ID` discount.
  Book the components (re-allocate the parent's net by standalone list price)
  and drop the parent; summing everything double-counts. The "Buy again" cart
  URL is a per-line `variantId:qty` manifest that survives "Show more"
  truncation. A `$0.00` warranty replacement order takes no `productQuantity`.
- Accessories the operator wants costed but not shelved take
  `stockTracked: false`. The vendor publishes no model numbers.
- A sibling storefront sharing the same Shopify account backend is its own
  Vendor (own descriptor, own city). A buyer-token order link can expire yet
  still render itemization; the in-app browser pane rendered it when Chrome hung.
  `/products.json` is the whole catalog with per-variant `featured_image`; parse
  it in the in-app pane (Chrome's JSON viewer mangles `innerText`).

## Costco

- Emails give only item number and price. The product page
  (`costco.com/p/-/<slug>/<catalogNumber>`) carries two identifiers — the
  header `Item ####` (`item_number`) and the URL's numeric segment
  (`catalog_number`) — and maker model/specs are lazy-loaded behind the
  **Specifications** tab (click, wait, re-read; multi-colour items list one
  model per variant). Images are AVIF, which `attach_file` rejects: swap the
  `.avif` extension on the AEM delivery URL for `.jpg`. Gallery `_1` is usually
  the clean hero.
- A **damage concession credit** on delivery is not a return: book the charge
  and the credit as settlement, set `statedTotal` to the amount charged, and do
  not add a discount Expense — the concession is already inside the line costs.

## Safeway (Albertsons)

- `/order-account/orders/{id}/item-details` collapses lines behind "Out of
  stock (N)" / "Shopped (N)" accordions — click both first. Sale price prints
  before regular price; qty>1 lines show the extended sale price; totals are
  "Estimated". The receipt PDF (from `/order-account/orders/{id}`, a `blob:`
  tab — screenshot it) carries the final total, per-line savings and fee
  breakdown, and can diverge from the estimate on weight-sold produce.
- Product `<img>` alts carry the Albertsons BPN id; `/shop/product-details.{bpn}.html`
  JSON-LD `gtin13` is **UPC-A without its check digit, zero-padded** — take the
  last 11 digits and recompute. Produce carries store-internal PLU codes, not
  consumer UPCs. Images:
  `images.albertsons-media.com/is/image/ABS/{bpn}?wid=800&hei=800&fmt=jpeg`.
  Store the BPN as `safeway` / `retailer_sku`.
- Bag fee and container deposit (CRV) are `fee`; driver tip is `tip`. Settlement
  is `pending` with a vendor sourceRef until the statement row lands.

## Farmers-market Square receipts

- A `squareup.com/r/<hex>` receipt link extracts as text (lines, total, tender,
  auth code). Use the receipt's `#XXXX` code as `orderId` and the hex as a
  `square` sourceRef. A ranch or stand with a Shopify site exposes
  `/products.json?limit=250` with SKUs, grams and images, no barcodes; market
  prices run a little under online list.
- Different stores' versions of the same generic (two 90/10 ground beefs) are
  separate Products that both link to **one** ingredient.

## Weee! (additions)

- The wallet is one `stored_value` FinancialAccount; card descriptors vary by
  provider (`WEEE INC.`, `Weee Inc`, `Grocery Weee!`).
- Bagged produce sold by count keeps `each` = one piece with the bag as an
  explicit unit mapping and the Expense `productQuantity` null — see
  product-promotion-and-receiving.md.
- Discontinued listings simply do not appear in the public search; those
  products stay imageless.

## Zoro

- The signed-in order history (`/my-account/order-history` → `/my-account/order/<WB…>`;
  `/account` 404s) prints the Order Totals block **and per-line purchased
  price/total** — the vendor's own post-discount line amounts, plus the Mfr #
  the public listing sometimes hides and the payment transaction id. Pages are
  client-rendered: wait ~3 s after navigate. `Download PDF` has no href.
- Zoro # → Mfr # is safe; **Mfr # → Zoro # is ambiguous** (one maker model can
  have several live Zoro listings at different prices). The order line, not a
  catalog search, disambiguates.
- Drive a vendor enrichment pass off its **principal Expense lines**, not its
  Products — a product worklist cannot see an expense with no Product.

## Facebook Marketplace and cash sales

- Shipped Marketplace sales leave a full email trail from
  `noreply@marketplace.facebook.com`. **Local cash handoffs leave nothing**, and
  listing-export coverage must be established before using absence as evidence.
  Do not repeatedly search sources already confirmed not to cover the event.
  Book from the operator's recollection with a
  placeholder date, say `DATE IS APPROXIMATE` plus the empty sweep in both the
  Expense and Purchase notes, at full earnings (no fee, no label).
- A lot sale covering several items still gets one Expense per Product (an
  `allocation` row cannot carry `productId`, which would strip the exits and let
  a later import re-stock them); ask the operator for the split and mark every
  row `OPERATOR-ALLOCATED SHARE, NOT A QUOTED PRICE`.

## Crowdfunding

- A Kickstarter reward leaves no order-export trail. Book `Kickstarter` as the
  vendor, dated to the charge (a pledge is only money once the project funds).

## Sloat Garden Center and counter sales

- No digital receipts, ever. A statement-backfill placeholder named
  `"<Vendor> counter purchase — unitemized"` may already exist for the charge;
  attach the hand row to that Purchase with `link_expenses_to_purchase`, copy
  the placeholder's provenance onto `Purchase.notes`, and delete the placeholder.
  A statement charge is tax-inclusive, so no tax row is owed.

## shop.app (Shop Pay order-tracking aggregator)

- It is an aggregator, not a vendor: every underlying merchant is its own
  Vendor, the same way a SIDIO sibling storefront is (see above). Never create
  a "Shop" or "shop.app" Vendor.
- A row is real checkout evidence only when its order page has an expandable
  **Receipt** panel with Subtotal/Shipping/Tax/Total and a payment method. That
  panel means the merchant's own Shopify store processed the order (small
  independent Shopify sellers, in-store Shop Pay taps) and its numbers are
  trustworthy. A row with no Receipt panel — Amazon, eBay, Home Depot, and any
  other non-Shopify retailer — is shop.app merely parsing a shipping/tracking
  notification for its own UI; the price and quantity shown can be wildly
  wrong, including both inflated quantity and price.
  **Never book from a receipt-less row.** Cross-check its order id against
  existing Purchases first (Amazon/eBay/Home Depot usually already have their
  own import pipeline and the row is a duplicate you'd otherwise re-book), and
  if it is genuinely new, enrich from the retailer's own order-history page
  instead — Home Depot's Purchase History, the eBay order page, etc.
- Per-line prices already reflect any order discount: the receipt also prints
  an informational `Order discount` amount, but it is not subtracted again —
  `Subtotal + Shipping + Tax` (using the shown per-line prices) equals `Total`.
  Do not re-derive a discount Expense from that line.
- Deposits/rentals can render as `$0.00` per line
  while the receipt's `Subtotal` still includes their real value — the
  difference between the sum of visible line prices and `Subtotal` is the
  hidden deposit total. Cross-check against a later partial refund: if the
  order's current net total (shown struck-through against the original on the
  order-history list) drops by exactly that amount, the deposits were returned
  in full, and it is safe to book the original charge plus a matching refund.
- The order-history list infinite-scrolls, but a single scroll-to-bottom only
  fires one page fetch (`POST /web/api/order-history`, cursor-paginated,
  10/page) — further scrolls at the same position do not retrigger it. Scroll
  up a few ticks and back down in several small increments to force the
  intersection observer to re-fire; repeat per page. A fresh navigation resets
  to page one and forgets everything already scrolled.
- Clicking an order row's "Receipt" toggle is unreliable via ref click when
  the panel was just rendered; take a screenshot and click its coordinates
  (or `find` again after a wait) rather than trusting one click to have
  registered.
