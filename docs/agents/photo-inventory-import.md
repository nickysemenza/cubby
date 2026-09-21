# Codex-managed photo inventory import

Keep import state in a local manifest outside the repository. Do not create an application import-session entity. Do not put household filenames, notes, or receipt data in public fixtures or commits.

Photograph each item overview first, followed by readable labels and optional details or spoken notes. Photo counts can vary. Preserve original files, capture timestamps, and ordering; timestamps help grouping but are not unique item identifiers. No manual numbering is required.

A manifest records:

- Source path, SHA-256, capture time, MIME type, and original order.
- A local group identifier, overview/label/detail roles, note references, and confidence/issues.
- Duplicate-file decisions separately from additional views and additional owned copies.
- Intended Product fields, intended physical location, explicit person ownership, quantities and units.
- Cubby shortcodes and an append-only write ledger with operation, intended payload, response/readback, and `planned`, `confirmed`, or `uncertain` state.

Use existing photo stage/upload/commit/reconcile and entity/inventory operations in bounded groups. Group by adjacency plus visual/label evidence; ambiguity stays in the manifest for review. Size belongs in the title. Preserve label evidence and uncertainty; do not infer composition from appearance or overwrite product names with analysis output.

Before each write, persist the intended payload locally. After each confirmed write, persist returned shortcodes and readback. If a response is lost, read and reconcile the relevant images/products/inventory before retrying. `photoImport.commit.idempotencyKey` is not a persisted replay receipt. Never blindly retry additive inventory writes.

Products and images may be created before a location is known. Recording inventory requires a real physical location. Explicitly set the intended individual owner; a product or location name is not ownership. Do not fabricate purchase dates, prices, vendors, receipts, or inventory-to-purchase relationships.

For location reconciliation, fetch the complete ownership-aware location snapshot and submit its opaque token. Never submit an owner-filtered wardrobe as the complete contents of a location. Reconcile concrete inventory entry IDs, not grouped display totals.

When receipts arrive later, match their Products independently. Inventory ownership may prefill an Expense beneficiary only through explicit confirmation. Historical Expense attribution survives later ownership changes and inventory removal. Recording a sale does not remove inventory; remove sold quantities separately and explicitly.
