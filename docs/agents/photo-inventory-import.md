# Photo inventory import

The `photo-inventory-import` skill owns user-requested imports of household
belongings, including wardrobe items. Keep the manifest local and outside the
repository; it is the source of truth for grouping, write intent, returned
shortcodes, and an append-only `planned`/`confirmed`/`uncertain` ledger.

Preserve each original path, SHA-256, MIME type, capture time, and source order.
Group photos from adjacency plus visible and label evidence. Record each image's
item/label purpose and confidence. `dupefile` means the same source
file, `additionalview` is another view of one physical thing, and `physicalcopy`
is another owned instance; they have different inventory consequences.

Use the existing MCP upload, attachment, Product CRUD, and inventory operations
for local folders. The native `photoImport` pipeline requires authentic native
analysis and is not a shortcut for this workflow. Do not invent native Vision
feature prints or analysis payloads. With `schedule_image_processing`, `get_image_processing`, and
`correct_image_description`, schedule and inspect the result before relying on
it; record only confirmed corrections. Original label
text is evidence and visual analysis is only a description: retain both, and do
not infer fabric or other unshown attributes.

For direct local attachments, use `create_file_uploads({items})` (up to 50),
keep every indexed result, and PUT each successful item to its presigned URL.
Then use `attach_files({items})` with the matching `uploadId`, target entity,
and purpose. Both tools have independent indexed outcomes: preserve successful
items and retry only failed indexes after the persisted intent and fresh
read-back show they were not completed. Never send local bytes or base64
through MCP.

Read a Product immediately before each attachment. Give each attachment a
deterministic idempotency key and its current complete `expectedImageCount`,
including label images and PDFs rather than only displayable covers. Several
attachments for one Product are dependent count changes: submit them in order,
advance the expected count only after read-back, and stop to reconcile on a
precondition failure. Product CRUD and inventory writes need a freshly read
target. Every inventory entry requires a real physical location and confirmed
ownership using the existing ownership model. On a lost response, reconcile affected images, Products, and concrete
inventory entry IDs before retrying; additive inventory is never retried blind.

The batch covers only the import the user requested. Clear items may create a
descriptive Product even with unknown brand or model; send uncertain groups to
exception review. Verified identical variants may share one Product. Count physical copies once;
existing inventory quantities can represent copies with the same owner/location. Do not infer prices, receipts, purchases,
vendors, or purchase relationships.

Use a dynamic, editable root/group/type taxonomy through one reference. Keep
size in the Product name and tags as attributes. Suggest existing choices only;
an import must not silently expand the taxonomy. The initial Apparel choices are Shoes
(sandals, sneakers, heels, boots); Clothes (shirts, shorts, pants, jackets,
skirts, sweaters, dresses); Accessories (purses, belts, hats).

Catalog enrichment may supplement own photos. Images record
`source` (`own`, `catalog`, or `unknown`), `sourcePageUrl`, `sourceAssetUrl`,
`sourceName`; Product attachments record `purpose` (`item` or `label`). A verified exact-product catalog overview image
may be the cover; do not replace a present gallery merely because a generic
image is available. Later receipts are matched independently; a photo import
does not create a Purchase or financial settlement.

Flag unsupported video separately. Keep original image files. Cutouts are optional
renditions of the same Image; schedule suitable item views, preserve complete
pairs, skip labels and already-transparent assets, and fall back to originals
when processing is pending or fails.

## Private manifest and recovery

Use a private directory outside the checkout with `manifest.json` and an
append-only `writes.jsonl`. Persist each change atomically before continuing.
The manifest holds a batch identifier, file records (path, SHA-256, capture
order/time, media type, duplicate-of), groups (member hashes, physical quantity,
purpose, evidence, uncertainties), proposed Product fields, existing matches,
owner/location decisions, and returned Product/Image/inventory shortcodes.
Keep identity evidence separate from classification confidence.

Each ledger entry records a stable local operation ID, group, tool, exact
payload, fresh preconditions, target shortcodes, expected quantity change, and
`planned`, `confirmed`, or `uncertain` outcome. Write `planned` before calling
the tool; record the response and a fresh read-back before `confirmed`. A
restart treats any planned entry without a result as uncertain. Search/read
using returned IDs, original hashes, target/location/owner, and the pre-write
quantity snapshot. Never infer success solely from a matching Product name.
If the additive inventory result cannot be distinguished from other stock,
ask about that exception instead of retrying. A duplicate file causes no new
attachment or possession; an additional view causes no quantity change; a
confirmed additional physical copy changes quantity once.

Hand off confirmed Product shortcodes and identity evidence to purchase import
and enrichment. Purchase/Expense matches do not receive inventory. Preserve
historical Expense attribution when current inventory has a different owner.
The checked-in `.claude/skills` sources are shared with Codex through the
`.agents/skills` link; update these sources, never installed plugin caches.
