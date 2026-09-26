# Retailer order corpus (synthetic)

Synthetic pages modeled on a saved retailer order-details layout and its
matching order-confirmation emails. All values are invented — order numbers,
ASINs, names, addresses, dates, prices, and product brand/model names — and
generated deterministically by `apps/web/tooling/build-retailer-corpus.ts`.
No real value from the source capture is embedded in these fixtures or in
the builder script.

Only the retailer's own generic template structure is preserved: the
`data-component` attribute names, class names, and section labels (`Order
placed`, `Order #`, `Ship to`, `Payment method`, `Grand Total`) that a real
order-details/order-confirmation page uses, so parsers and the purchase
agent see realistic markup shapes.

## Files

- `order-details-1.html` … `order-details-7.html` — synthetic order-details
  pages, one per shipment, with a synthetic order id, date, shipping address,
  line items (invented workwear brand/model/title), and an order summary
  (subtotal, shipping, tax, grand total) that is internally consistent
  (`subtotal + shipping + tax = grand total`).
  `order-details-3.html` and `order-details-4.html` are a deliberate
  split-shipment case: the same (synthetic) order id shipped in two parcels.
  Each page says so ("Shipment 1 of 2" / "Shipment 2 of 2"), the two pages
  share the same order date, and the ASIN they both list resolves to the
  same synthetic product title and unit price on both pages.
- `order-email-1.html`, `order-email-2.html` — synthetic order-confirmation
  emails in a Gmail-message-view shape, each matching one or more of the
  order-details pages above by (synthetic) order id. An email agrees with
  its matching order-details page(s) on order date and item lines/prices,
  and its grand total is the sum of all shipments of that order id (so
  `order-email-2.html` sums `order-details-3.html` + `order-details-4.html`).
- `expected.json` — the synthetic ground truth for every fixture (order id,
  ordered-at date, currency, grand total, and per-item ASIN/title/unit
  price; order-details entries also carry `shipmentLabel` when the order id
  has more than one shipment), used by the corpus's unit test, including its
  order/email consistency checks.

## Regenerating

```
tsx apps/web/tooling/build-retailer-corpus.ts <inputDir> apps/web/tests/e2e/fixtures/retailer-corpus
```

`<inputDir>` is a local (never-committed) directory of a "Save as" capture of
real order-details and order-confirmation pages. The builder parses the real
markup only to locate structural fields (order id, date, item title/price,
shipping address); every extracted value is discarded immediately after a
synthetic replacement is generated for it.
