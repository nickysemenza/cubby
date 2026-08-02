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
- Create a Product with all known fields in one rich `create_product` call; do
  not create then patch just to set category/model/tags/identifiers.
- Keep exact-SKU durable Expenses as product candidates even when currently
  unlinked. Conversely, do not force an aggregate Expense onto a Product when
  its individual cost is unknowable.
- Split exact merchandise subtotals automatically and keep separately stated
  shipping, tax, and fees as productless Expenses. Ask before inventing an
  allocation that the source does not establish.
- `misc:` inventory buckets remain product-link ineligible for Expenses.
- Product creation and Expense linking never changes inventory. Always ask
  explicitly before creating or moving Inventory Entries, even when Product
  promotion is automatic; report receiving separately.

For a durable and its consumables, share a compatible tag but attach
maintenance tasks to the durable Product, not its replacement consumable.
