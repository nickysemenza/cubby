# Product writes and images

Manufacturer pages are authoritative for manufacturer, model, concise canonical
name, and evidence for an existing taxonomy choice. Do not silently add categories. Exact retailer pages are authoritative for UPC, retailer
SKU, exact image, and current direct offer. A current `price` override replaces
the Expense-derived fallback; never infer it from a marketplace, crossed-out
price, aggregator, or receipt quantity. Nutrition decisions (`fdc_id` or
`labelNutrition`) belong to meal logging.

Cubby snaps `manufacturer` on create to an established live spelling, but not
on update. Check the established spelling before a manual correction. Create a
missing researched Product once with all proven metadata; creation does not
receive inventory.

For identifier-only work, `patch_product_external_ids` upserts one precise
source/kind slot and removes only an explicitly obsolete value with its exact
`expectedExternalId`; unrelated IDs survive and a changed live slot refuses the
patch. A full `entity update product` external-ID set is a deliberate complete
replacement: preserve every intended ID and remove MCP-only timestamps first.

For settled attachments, call `attach_files({items})`; every item supplies an
`entityId`, one `url` or `uploadId`, its idempotency key, and the freshly read
`expectedImageCount` for a Product gallery. This count includes all attachments,
including labels and PDFs. Use `itemImageCount` to find Products without item
imagery. Multiple files for one Product are dependent count changes, so prefer
separate target batches. Results preserve input indices independently; retry
only failed items after a fresh read, retaining their logical idempotency keys.
A count mismatch means the gallery changed.
Keep a write singular when it needs judgment during the mutation: a collision,
gallery drift, cover replacement, or fresh display-order decision.

Before attachment, compare the page and image with the standalone Product.
When the Product is a kit-packed component, a proven standalone variant can
support its image and retailer ID, disclosed in notes, but cannot supply the
kit package's UPC or replace the kit model. Do not detach an old cover before a
replacement is verified. Use URL fetch unless the source blocks it, then use
browser-downloaded bytes with the correct MIME.

If there is no separate retail/package variant, the listing's UPC remains the
Product's UPC. Confirm that distinction before treating a standalone listing as
kit-component evidence.

`verify_product_images`/`verify_products_images` returns the detailed Product.
Confirm the previous IDs survived, intended removals are absent, the new image
has a one-based display position and valid dimensions/MIME/SHA-256, and PDFs or
failed-integrity files remain non-displayable. Stop and report gallery drift on
any mismatch. A family image is allowed only when explicitly disclosed.
