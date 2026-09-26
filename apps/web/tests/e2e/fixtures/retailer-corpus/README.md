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
  pages, one per order, with a synthetic order id, date, shipping address,
  line items (invented workwear brand/model/title), and an order summary
  (subtotal, shipping, tax, grand total) that is internally consistent
  (`subtotal + shipping + tax = grand total`).
- `order-email-1.html`, `order-email-2.html` — synthetic order-confirmation
  emails in a Gmail-message-view shape, each matching one of the
  order-details pages above by (synthetic) order id.
- `expected.json` — the synthetic ground truth for every fixture (order id,
  ordered-at date, currency, grand total, and per-item ASIN/title/unit
  price), used by the corpus's unit test.

## Regenerating

```
tsx apps/web/tooling/build-retailer-corpus.ts <inputDir> apps/web/tests/e2e/fixtures/retailer-corpus
```

`<inputDir>` is a local (never-committed) directory of a "Save as" capture of
real order-details and order-confirmation pages. The builder parses the real
markup only to locate structural fields (order id, date, item title/price,
shipping address); every extracted value is discarded immediately after a
synthetic replacement is generated for it.
