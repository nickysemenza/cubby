# Porcelain Transit Entity-Route Truth Matrix

This document governs the Products reference inspector and later entity-route
surfaces. The route is a truthful projection of current contracts, not a
decorative graph.

## Topology decision

Product is the selected station. Inventory/Location, Purchase/Expense/Vendor,
Project, and Task are conditional branches from Product—not a universal linear
chain. The interface may visually continue through a branch only when the
record provides evidence for each edge. It must never imply that a Location
caused a Purchase or that a Purchase belongs to a Project merely because all
three relationships exist somewhere on the Product.

Direct branches appear first. Derived rollups and secondary branches sit behind
counts or disclosure. Empty branches state what is absent without inventing a
station.

Product routes are part of the Pantry/Inventory domain for navigation and use
that family's green wayfinding mark. Relationship route UI indexes the existing
specialized sections and queries; it must not duplicate their data into a new
client-side ledger.

## Product relationship matrix

| Edge | Cardinality and meaning | Priority | Current data owner | Empty behavior | Canonical target |
| --- | --- | --- | --- | --- | --- |
| Product → InventoryEntry | One-to-many stock records embedded in Product detail | Primary | `entity.detail` Product loader; inventory mutations own edits | Show no stock records; do not erase identity-only Locations | `/inventory/$shortcode` |
| Product → Location | Two distinct one-to-many projections: holding locations through InventoryEntry, and Locations whose identity is this Product | Primary | Product detail projection and `ProductStockedAt` | Distinguish “not stocked” from “serves as a location” | `/locations/$shortcode` |
| Product → Expense | One-to-many acquisition or exit/disposition lines keyed by `productId` | Primary | `expense.chartData` and expense entity mutations | Explain kit-owned expenses or explicit manual price when applicable | `/expenses/$shortcode` |
| Product → Purchase | Many purchases from explicit `PurchaseProduct` provenance or inferred itemized Expenses; sources are not equivalent | Primary | `productOperations.purchases`; detach only owns explicit links | Explain both missing paths and kit-parent provenance | `/purchases/$shortcode` |
| Product → Vendor | Derived many-to-many spend rollup, not a direct Product foreign key | Secondary | `product.vendors` related-view summary | “No vendor spend is attributed to this product yet” | `/vendors/$shortcode`; expense drilldown remains filtered `/expenses` |
| Product → Project | Two meanings: purchase attribution and explicit reusable-tool usage | Primary for tools/software; otherwise secondary | `productOperations.projectUses` plus Expense project attribution | Keep “used on” separate from “purchased for”; show Unassigned when real | `/projects/$shortcode` |
| Product → Task | One-to-many through nullable `Task.subjectProductId`; shown for non-food Products | Primary when available | `task.chartData` | “No tasks linked” with the existing creation path | `/tasks/$shortcode` |

## Required station labels

- `Stock`: InventoryEntry rows and their holding Locations.
- `Also a location`: Locations whose identity is this Product.
- `Expenses`: acquisition and disposition evidence.
- `Purchases`: order provenance, with `Direct link` or `Via expense` source.
- `Vendors`: derived attribution, visually secondary.
- `Used on projects`: explicit reusable-tool usage.
- `Purchased for projects`: expense attribution, visually secondary.
- `Tasks`: subject-linked work history.

Do not collapse the paired labels above. Their distinctions are current product
truth and must survive the new visual shorthand.

## Current implementation evidence

- Product detail and schemas:
  `packages/schemas/src/product.ts`,
  `apps/web/src/app/_components/products/product-detail.tsx`.
- Stock and Location semantics:
  `apps/web/src/app/_components/products/product-stocked-at.tsx`.
- Purchase provenance:
  `packages/schemas/src/purchase.ts`,
  `apps/web/src/app/_components/products/product-purchases.tsx`.
- Expense, Project, and Task histories:
  `product-expense-history.tsx`, `product-project-uses.tsx`, and
  `product-task-history.tsx` in the Product component directory.
- Registered graph relations:
  `packages/schemas/src/related-view.ts`.
- Canonical routes:
  `apps/web/src/entities/generated/entity-routes.gen.ts`.

## Known gap that does not require a schema change

`ProductPurchaseOut` carries `vendorName` but not `vendorId`. A Purchase station
therefore cannot jump directly to Vendor detail using that DTO. It must open the
Purchase, while the dedicated Vendor summary owns Vendor links. The reference
inspector can be built from existing queries and detail contracts without a
backend or schema change.
