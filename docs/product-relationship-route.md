# Product relationship route

This is the durable contract for Product relationship previews. It describes
data truth and API boundaries; generic inspectors and route renderers must not
recreate these semantics with client-side fan-out.

## Topology

Product is the selected station. Inventory/Location, Purchase/Expense/Vendor,
Project, and Task are conditional branches from Product, not a universal chain.
A visual route may continue through a branch only when the record supplies
evidence for every edge. Existing relationships must never imply that a
Location caused a Purchase or that a Purchase belongs to a Project.

Direct branches appear before derived rollups. Empty branches explain what is
absent without inventing a station. Product remains in the Pantry/Inventory
navigation family.

## Public contract

The public operation is one `product.relationshipRoute` query keyed by the
Product's canonical public shortcode. Its result:

- separates `direct` and `derived` branches structurally;
- returns exact branch counts and at most three deterministic, ordered previews;
- uses canonical public shortcodes for every linked station; and
- exposes source/provenance labels, never SQL or renderer concerns.

The projection is Product-owned and is reusable by Product detail, the
relationship index, and bounded previews. Deeper branch pagination remains
lazy. Generic layout owns only disclosure, links, loading/error geometry, and
accessibility. This contract requires no database migration.

## Relationship semantics

| Station                | Meaning and source                                             | Required distinction                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Stock                  | Product → InventoryEntry → holding Location                    | A holding Location is not an identity-only Location.                                        |
| Also a location        | Location whose identity is this Product                        | Keep separate from “Stock”.                                                                 |
| Expenses               | Acquisition or disposition lines keyed by `productId`          | Explain kit-owned expenses and explicit manual prices where applicable.                     |
| Purchases              | Explicit `PurchaseProduct` links or inferred itemized Expenses | Label `Direct link`, `Via expense`, or both; exit/future Expense rows are not acquisitions. |
| Vendors                | Derived attributed Product Expense → Purchase → Vendor spend   | An explicit `PurchaseProduct` link alone is not vendor spend.                               |
| Used on projects       | Explicit reusable-tool usage                                   | Keep separate from acquisition attribution.                                                 |
| Purchased for projects | Derived acquisition-spend project attribution                  | A Project may appear in both project branches.                                              |
| Tasks                  | Nullable `Task.subjectProductId` links for non-food Products   | Preserve the existing task creation path and truthful empty state.                          |

Required station labels are `Stock`, `Also a location`, `Expenses`, `Purchases`,
`Vendors`, `Used on projects`, `Purchased for projects`, and `Tasks`. Do not
collapse paired meanings into a decorative graph. A recategorized Product keeps
historical project-use evidence visible and linkable, but category-gated
mutations remain read-only rather than silently broadening.

## Visibility and schema boundary

Soft-deleted intermediates and targets never appear in counts or previews.
Unassigned project attribution is shown when it is real. Every linked target
opens its canonical route, including `/inventory/$shortcode`,
`/locations/$shortcode`, `/expenses/$shortcode`, `/purchases/$shortcode`,
`/vendors/$shortcode`, `/projects/$shortcode`, or `/tasks/$shortcode`.

`ProductPurchaseOut` remains unchanged: it carries `vendorName`, not `vendorId`.
Purchase stations open Purchases; the derived Vendor branch owns Vendor links
from its own evidence. The route output is an API contract, not a schema or
database migration. Existing specialized Product sections remain the source
of their mutation behavior and are not duplicated by the relationship preview.

The [local journey coverage map](agents/core-journey-e2e.md) tracks the
relationship browser check alongside the Product, photo, order, and statement
journeys that create its underlying evidence.
