# Kits, bundles, and discount allocation

## Which shape a multi-item purchase takes

- **Components have no standalone identity or price** (kit-only bag, kit-only
  bits) → kit parent with `ProductComponent` edges. The kit is the real unit.
- **Components are standalone products of similar value** (battery + charger
  starter kits, clamp sets) → kit parent is fine; quantity weighting
  approximates well.
- **Components are standalone products of disparate value** (a saw bundled with
  a "bonus" stand at one price) → keep separate Expenses apportioned by
  **relative list price**. `ProductComponent` divides a parent's cost by
  quantity weight, not value, and the failure is silent: edges look right, the
  parent reconciles, and money lands in the wrong places. Nothing in the schema
  expresses the constraint.
- A "(combo, X portion)" split is not always a blown-apart kit: sometimes it is
  two separately-listed items whose line prices were never captured. The fix is
  recovering the vendor's line prices, not reassembling.

## Order-level discounts and BOGO

When a vendor applies one discount across items without saying which item it
reduced, **split it by relative list price** — even when the promo reads "buy
one get one free". Zeroing one item manufactures a permanently unpriced
product (the missing-price detector has no exception mechanism for "genuinely
free"), contradicts how bundled free components already draw a share, and is a
choice made on the vendor's behalf. Do not reuse the old `$0.10` placeholder
workaround. Back tax out of merchandise into a typed `tax` row; an extracted
tax landing exactly on the local rate is a strong check on the merchandise
figures. A free promo line the vendor itself prices at `$0.00` (Acme's `F`
SKUs) is free, not missing spend.

## Splitting a kit Product into components

1. Create each component with a rich `entity create product`.
2. `split_expense` the kit's Expense into parts allocated by standalone list
   price scaled to the kit price; put the arithmetic in each part's notes.
   Battery kits break this (the battery alone lists above the kit) — use an
   equal split and say it is a convention. Sanity-check each reference price
   against its siblings first: one outlier moves real money onto every other
   component.
3. Link any sale/exit Expenses to the component actually flipped
   (`productQuantity: -1`). **Always search the ledger for an exit before
   stocking a component** (`entity list expense` by name/model with
   `costMax: 0` in the months after the purchase): a
   kit may have been bought for one part and the rest sold, leaving unlinked
   sale rows.
4. Delete the kit's inventory entry, create one per component still owned.
5. Delete the kit Product. `block-live-project-use` refuses when the kit has
   `ProjectToolUsage` rows — `preview_entity_operation` shows it; repoint the
   tool component onto each project (`repoint_project_uses`), don't just detach.
6. **Carry nothing from the kit.** Its ASIN names the set, its cover is a group
   shot, and `delete` removes the file. Each component takes its own retail
   listing's identifiers and image, disclosed in notes as sourced from the
   standalone SKU — but **not that listing's UPC** (a barcode identifies a
   package the kit-packed unit never came in; batteries with no kit/retail
   split take the UPC normally). The split and the enrichment pass are one
   workflow: new components land at `imageCount: 0` and look finished.

A split never changes purchase reconciliation (`expenseTotal` unchanged), so
`reconciliation: "match"` afterwards is the cheap proof of allocation to the
cent. Two-cent drift on even quantities is structural (per-each price rounds
before inventory multiplies). When a component product already exists, the
split adds a second unit and its derived price becomes the blended average —
say so in the notes. A split can also *supply a missing acquisition*: a
component later sold shows as an exit with no purchase until the kit line is
split, so look for an unsplit kit on the same platform before writing off an
orphan sale. A kit's own components are the usual orphan sales — test a
"replaced an older unit" story by searching for a prior acquisition of that
exact model. A kit flipped intact is a weak split candidate.

**Under-splits are the harder failure**: every tool booked, the bundled
battery/charger/bag silently dropped. Detect by reading the kit's published
contents (manufacturer page, or Home Depot's `Includes:` bullets) against the
rows created, not by counting expenses. Home Depot's CSV exports a bundle as a
priced parent plus one `$0.00` row per component sharing the parent's internet
number — group on `(Order Number, Internet SKU)` for a machine-readable roster
that also names each component's store SKU. Fixing an under-split re-allocates
the tools' existing cost bases; say so first. Used "battery and charger" eBay
lots are under-splits too.

Pack SKUs impersonate single SKUs in search results; verify the pack count on
the listing. A promo/bundle internet number parked on a component belongs on
the parent. A manufacturer's "no longer available" says nothing about retailer
availability — get the internet number and open the PDP before allocating by
residual. Manufacturer contents lists beat reasoning from model numbers (a
router kit ships a fixed and a plunge base, not the under-table one; a
lighting kit ships a wallplate, no pedestal).

## N-packs

Splitting every N-pack is hundreds of new Products with no payoff. The
high-value subset is **packs whose single-unit twin already exists** — two
records describing one physical thing. Find them by normalized-name equality
(strip `N-pack|N pk|N ct|N count|N-piece`, same manufacturer) and by
model-prefix (`pack.model` starts with `single.model`); read every suggestion,
because both joins produce false positives (a filter 2-pack paired with the
appliance it fits; one kit paired with a different kit). The trailing marker of
a pack SKU encodes the count (`-T`, `-2`, `-04W`); strip it for the single and
leave it on the parent, except where the model legitimately belongs to both.

The split test is "does one unit have an independent life" (located, installed,
consumed on its own): discrete durables pass; fastener packs, disposables and
N-piece *sets* fail — the pack is the unit. **Before minting a pack's single,
look it up under the single's SKU and by product family** (`model ~ '^VF[0-9]'`),
never by the pack's own name. An N-pack can be an *assortment* (one of each
grit/size/colour) — the tell is "Set"/"Assortment" or non-repeating items;
attaching one component ×N is wrong there.

## Manufacturer recovery

`manufacturer = generic` with the brand as the first word of the name is an
import artifact; recover it by self-joining the catalog's distinct manufacturer
values against the start of each generic product's name — and **read every
suggestion**, because short brand tokens match produce and screws (`Glad` →
"Gladiolas", `MAC` → "Machine screw"). Skip books (the publisher is the maker,
not the author). A trademarked product line (ProPress, MegaPress) identifies the
maker as a fact; a neighbouring part number does not. Import artifacts cluster
by source ("Vacuums" as a brand on filters from two different makers). The
large remainder — commodity PVC fittings, nipples, mud rings, produce, machine
screws — is correctly generic.

`product_model` admits `not_issued` / `unavailable` exceptions (not
`not_applicable`, which is legal for `product_manufacturer` and
`product_category` only). The check fires only for stocked products in
model-required categories; a component that is neither stocked nor carries its
own Expense reads complete with a null model.

## Construction materials leaving "Not on a shelf"

Products bought for a project and built into the house sit in the `unlocated`
view forever until one of three lanes is applied, per product family, with
confirmation:

| Lane | State | Mechanic |
|---|---|---|
| 1 | Fully consumed (milled, buried, poured) | `Product.stockTracked = false` |
| 2 | Installed fixture that still exists in place | one `InventoryEntry`, `placement: 'installed'` |
| 3 | Partly used — a real remainder on the shelf | **two** entries at the same location: `stock` = remainder, `installed` = used portion, in `each` |

Lane 3 reconciles exactly because on-hand includes installed rows; a mixed-unit
product makes the on-hand SQL return NULL, so never record the remainder in
`ft`. **Do not blanket-sweep `stockTracked = false` over the project-materials
cohort**: `projectId` + `costType = 'materials'` is evidence, not proof, and the
cohort holds roll goods (lane 3), household items mis-attributed at order level,
installed electronics (lane 2), and real durables categorized as supplies.
Perishables and live plants take `stockTracked: false` at import.

Container compatibility: same-nominal totes from different brands do not
interstack; tag each Product `tote-<size>` plus `stack-<brand>-<size>`, and
confirm the brand before accepting the default product on a new bin Location.
