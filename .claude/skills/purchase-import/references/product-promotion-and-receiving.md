# Product promotion and receiving

Promote a receipt line only when it identifies a specific durable, consumable,
subscription, or repeatable commodity and carries a defensible Product cost
basis. A generic name or mixed bucket is not sufficient.

- Use `generic` manufacturer only when no maker is stated. Dimensions, grade,
  treatment, finish, and profile can identify commodity materials.
- Put manufacturer models in `model`. Put retailer SKU, catalog, internet, or
  item numbers in typed `externalIds`.
- Create a Product with all known fields in one rich `create_product` call; do
  not create then patch just to set category/model/tags/identifiers.
- Keep exact-SKU durable Expenses as product candidates even when currently
  unlinked. Conversely, do not force an aggregate Expense onto a Product when
  its individual cost is unknowable.
- `misc:` inventory buckets remain product-link ineligible for Expenses.
- Product creation and Expense linking never changes inventory. Ask explicitly
  before creating or moving Inventory Entries; report receiving separately.

For a durable and its consumables, share a compatible tag but attach
maintenance tasks to the durable Product, not its replacement consumable.
