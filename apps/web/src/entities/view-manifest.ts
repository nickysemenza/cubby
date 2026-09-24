import type { Entity } from "@cubby/schemas/entity";
import type { ProblemKey } from "@cubby/schemas/problems";
import { PROBLEM_CLASS } from "@cubby/schemas/problems";
import {
  LIVE_PROJECT_STATUSES,
  taskStatusValues,
} from "@cubby/schemas/project";
import { z } from "zod";

import { FILTER_ANY, FILTER_NONE } from "./filters";
import {
  defineProblem,
  type EntityProblemSource,
  type ProblemQuery,
  validateProblemQueries,
} from "./problem-query";

/**
 * Hardcoded saved views: a named starting point of filters + sort for a list
 * table.
 *
 * These used to be view-switcher tabs whose filters lived in a
 * `Partial<ExpenseFilters>` spread into `useEntityList`'s contextual scope.
 * That spread wins over the manifest-derived filters, so on a preset tab the
 * matching header control stayed interactive but inert — you could pick a
 * trade and nothing happened. The preset was also invisible in the URL, so a
 * view was unshareable and un-bookmarkable.
 *
 * A view is now a *declaration* rather than a code path: applying one sets
 * real column-filter state, which the existing `useTableState` write-back
 * effect serializes to the URL. So a view and a shared link are the same
 * thing by construction, the header controls stay live (editing one just
 * drops the active checkmark), and no filter is applied that the chips can't
 * show.
 *
 * Deliberately dependency-free (`.ts`, no `~/` imports, no JSX — unlike
 * `filter-manifest.tsx`, which carries icon-bearing option lists) so vitest's
 * `unit` project can load it and assert the invariants in
 * `view-manifest.unit.test.ts`.
 */

/** A view's pinned filter state, in the manifest's own vocabulary — the same
 *  `{id, value}` shape `decodeFilters` produces and `table.setColumnFilters`
 *  consumes, so no translation layer is needed in either direction. */
interface ViewFilter {
  id: string;
  value: string | string[];
}

interface ViewLayout {
  columnOrder: string[];
  columnPinning: { start: string[]; end: string[] };
  columnVisibility: Record<string, boolean>;
  columnSizing: Record<string, number>;
}

const DEFAULT_CURATED_LAYOUT: Omit<ViewLayout, "columnVisibility"> = {
  columnOrder: [],
  columnPinning: { start: [], end: [] },
  columnSizing: {},
};

/**
 * Marks a view as ALSO being a Problems section, so one declaration produces
 * the saved view, the shareable URL, and the Problems card.
 *
 * This is the anti-divergence move. Several detectors used to re-write in SQL a
 * predicate the entity's list already expressed as filters — and the schemas
 * said so out loud: `productFilterFields.expectedQuantityMax` documents
 * `-1` as "the 'sold or returned more than was ever bought' worklist", which
 * is exactly what a since-deleted detector re-derived with a
 * grouped HAVING scan. Two implementations of one question, two places to drift.
 *
 * The card's rows come from the entity's ordinary list procedure, whose output
 * shape is a SUPERSET of the row schema the detector used to return (a
 * location list row carries `images[]` and `inventoryEntries[]`, which is where
 * the old hand-written `firstImageUrl` subquery and `itemCount` rollup came
 * from). So converting deletes SQL rather than moving it.
 */
interface ViewProblem {
  /** Keeps `PROBLEM_CLASS` exhaustive — the class itself stays on the schema
   *  side, because defect-vs-coverage is about meaning, not about selection. */
  key: ProblemKey;
  title: string;
  description: string;
  emptyMessage: string;
}

export interface ViewDefinition {
  id: string;
  label: string;
  description: string;
  filters: ViewFilter[];
  sort?: Array<{ id: string; desc: boolean }>;
  /** Optional curated layout. Applying it replaces every layout slice after
   * normalization against the table's current code-defined columns. */
  layout?: ViewLayout;
  problem?: ViewProblem;
}

/**
 * Saved views select records; renderer tabs never do.
 *
 * A view may additionally declare a `problem`, which makes it a Problems
 * section too. Not every detector can become one — a predicate the flat filter
 * vocabulary can't express (no OR-tree, no negation, no HAVING over groups),
 * one whose bound is relative to now, or one whose correctness rests on a
 * compile-time weld a data
 * declaration can't carry. `findOrphanedProducts` is the third kind and says so
 * at its own definition.
 */
const defineViewManifest = (
  manifest: Partial<Record<Entity, ViewDefinition[]>>,
): Partial<Record<Entity, ViewDefinition[]>> => manifest;

export const viewManifest = defineViewManifest({
  project: [
    {
      id: "active",
      label: "Active",
      description: "Projects that have not been completed",
      filters: [{ id: "status", value: [...LIVE_PROJECT_STATUSES] }],
    },
    {
      id: "completed",
      label: "Completed",
      description: "Finished projects, including sub-projects",
      filters: [{ id: "status", value: ["done"] }],
    },
  ],
  task: [
    {
      id: "inbox",
      label: "Inbox",
      description: "Open top-level tasks with no project",
      filters: [
        {
          id: "status",
          value: taskStatusValues.filter((status) => status !== "done"),
        },
        { id: "projectId", value: [FILTER_NONE] },
        { id: "parentTaskId", value: [FILTER_NONE] },
      ],
    },
    {
      id: "completed",
      label: "Completed",
      description: "Finished tasks, including subtasks",
      filters: [{ id: "status", value: ["done"] }],
      sort: [{ id: "updatedAt", desc: true }],
    },
  ],
  expense: [
    {
      id: "planned",
      label: "Planned",
      description: "Committed spend that hasn't happened yet",
      filters: [{ id: "future", value: "true" }],
      // Ascending, so the soonest lands first. Undated rows sort last on
      // Postgres's default NULLS LAST — no extra sort logic needed.
      sort: [{ id: "date", desc: false }],
    },
    {
      id: "unassigned",
      label: "Unassigned",
      description: "Spend never attributed to a project",
      // The `(none)` sentinel of the Project column's own picklist — the same
      // value a user gets by picking it by hand.
      filters: [{ id: "projectId", value: [FILTER_NONE] }],
    },
    {
      id: "unclassified",
      label: "Unclassified",
      description: "Trade 'other' with no cost recorded",
      filters: [
        { id: "trade", value: ["other"] },
        { id: "cost", value: "none" },
      ],
    },
    {
      id: "unattached",
      label: "Unattached",
      description: "Expenses with no Purchase attached",
      // The Purchase column keeps the vendor URL filter despite its new field ID.
      filters: [{ id: "purchaseId", value: [FILTER_NONE] }],
    },
    {
      id: "goods-no-product",
      label: "Goods without a product",
      description: "Purchased items and tools not yet linked to a Product",
      // Narrowed to `principal` goods on purpose: services are labor and carry
      // no product by design, and tax/shipping/discount/fee lines structurally
      // can't hold one. Without both filters this reads as a far larger backlog
      // than it is, because correctly product-free rows dominate the count.
      //
      // `lineBasis` excludes the third never-satisfiable class: deposits,
      // balances and estimated materials/labor splits, which are slices of an
      // un-itemized total rather than gaps. Small by count but they dominate
      // the top of this cost-sorted list, because lump-sum structure
      // correlates with size — the largest purchases are the ones paid in
      // installments.
      filters: [
        { id: "lineKind", value: ["principal"] },
        { id: "lineBasis", value: ["item_line"] },
        { id: "costType", value: ["materials", "tools"] },
        { id: "productId", value: "none" },
      ],
      sort: [{ id: "cost", desc: true }],
    },
    {
      id: "legacy-goods",
      label: "Legacy goods lines",
      description: "Hand-entered goods with no product and no purchase",
      // `goods-no-product` plus the no-purchase sentinel: rows typed straight
      // into the ledger before the vendor roster existed, so there is no
      // receipt to promote a Product from. Worth triaging by hand rather than
      // batch-importing.
      filters: [
        { id: "lineKind", value: ["principal"] },
        { id: "lineBasis", value: ["item_line"] },
        { id: "costType", value: ["materials", "tools"] },
        { id: "productId", value: "none" },
        { id: "purchaseId", value: [FILTER_NONE] },
      ],
      sort: [{ id: "cost", desc: true }],
    },
    {
      id: "unknown-quantities",
      label: "Missing quantities",
      description: "Product-linked lines that prove a cost but not a count",
      // The editable half of the product list's view of the same name: that one
      // names the affected Products, this one selects the rows that actually
      // carry the writable field. It's the backlog behind the `+N?` cue on the
      // relationship summary tables, whose `unknownAcquisitionQuantityCount`
      // counts exactly these lines.
      //
      // No `lineKind`/`lineBasis`/`costType` narrowing, unlike `goods-no-product`
      // above — `product: has` already does that work. A quantity is only
      // meaningful once a line names a Product, and the tax/shipping/fee lines
      // those filters exist to exclude never carry one (every product-linked
      // Expense in the ledger is `principal`). Restating it would imply a
      // distinction the data doesn't have.
      filters: [
        { id: "productId", value: "has" },
        { id: "productQuantity", value: "none" },
        // A planned line has no count yet by construction, not by omission —
        // and the `+N?` cue skips it for the same reason.
        { id: "future", value: "false" },
      ],
      // Deliberately NOT mirroring the cue's `cost > 0`: no cost preset
      // expresses it (the closest, `credits`, is `costMax: 0`). The divergence
      // is refunds and $0 lines, which are worth quantifying too — so this view
      // is a superset of the cue, never a subset that hides work.
      sort: [{ id: "cost", desc: true }],
      // Visible by default, but visibility persists per user — someone who has
      // hidden Quantity would otherwise land on a list selected on an invisible
      // signal, with the one field they came to edit missing.
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { productQuantity: true },
      },
    },
  ],
  product: [
    {
      id: "shelf-disagrees",
      label: "Shelf disagrees",
      description: "Stocked products whose count differs from the ledger",
      // Server-scoped to products that are BOTH stocked and in the ledger —
      // see `quantityVarianceFilter` in the product repo. Neither half is
      // optional: without "stocked" this is dominated by things correctly sold
      // off, and without "in the ledger" by stocked products that have no
      // product-linked Expense at all (a provenance gap, not a counting one).
      //
      // A broad shelf-reconciliation worklist: it never converges to zero,
      // which is why it lives here rather than as a Problems section. The
      // narrower acquisition-history gap — more recorded units gone than
      // arrived — is surfaced separately as `negativeExpectedQuantity`.
      filters: [{ id: "quantityVariance", value: "mismatched" }],
      // Both hidden by default on a table this wide, so the view has to reveal
      // them — otherwise it selects rows on a signal nothing on screen explains.
      // `servingAsLocations` joins them because a product can now be short
      // while sitting in no inventory row at all: eight 7-gal totes bought,
      // three in service as bins, five nowhere. Without the column the row
      // reads as a bare -5 with an empty Location cell.
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: {
          ledgerExpectedQuantity: true,
          quantityVariance: true,
          servingAsLocations: true,
        },
      },
    },
    {
      id: "unknown-quantities",
      label: "Missing quantities",
      description: "Products whose expense lines don't establish a count",
      // The data-entry backlog behind the `+N?` cue: a receipt that proves the
      // cost but not the count leaves the expected quantity understated, and
      // nothing infers one (a nullable quantity is never read as 1).
      filters: [{ id: "ledgerExpectedQuantity", value: "unknown" }],
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { ledgerExpectedQuantity: true },
      },
    },
    {
      id: "unlocated",
      label: "Not on a shelf",
      description:
        "Bought, never sold, and held nowhere — not on a shelf, not a bin, not inside a kit",
      // The other half of `shelf-disagrees`, and the half that view cannot
      // reach: `quantityVarianceFilter` is scoped to products that are BOTH
      // stocked and in the ledger, and `onHandUnitsSql` returns NULL for a
      // zero-entry shelf — so a product the ledger says you own with nothing
      // on a shelf matches neither "mismatched" nor "matched". It needs no new
      // server predicate beyond `stockTracked`, only these filters combined.
      //
      // Converges by decision, not by category guessing: `stockTracked: null`
      // is the undecided worklist, so a product leaves this view the moment
      // it's reviewed — marked `false` (no shelf claim wanted: bananas,
      // software) or `true` (shelf records are kept). Without that filter
      // every consumable ever bought stayed "owned" here forever, because
      // inventory never auto-decrements (a tenet); with it, the view shrinks
      // as the operator works through the backlog instead of refilling on
      // every grocery purchase. Still sorted by price so the money surfaces
      // first while the backlog is large; `unlocated-durables` below is the
      // shortcut, not the answer.
      //
      // `servingAsLocations: none` is what keeps this DISJOINT from
      // `shelf-disagrees`. Presence has THREE forms — stock on a shelf, the bin
      // itself, and stock held by a kit's parts — and this view means none of
      // them. Without the second the HDX totes appeared here under "stocked
      // nowhere" while three of them were bins in daily use, and the same rows
      // showed in both views telling different stories.
      //
      // `components: none` is the third, and the same argument one step out. A
      // kit that has been split into a composition record keeps the Expense and
      // holds no stock of its own — the shelf claim moved to its parts — so a
      // decomposed kit is not "stocked nowhere", it is stocked as its
      // components. The parts are also the ACTIONABLE rows: an unstocked
      // component carries its own projected `expectedQuantity` (the kit's units
      // reach it through `ProductComponent`) and matches this view by itself, so
      // admitting the parent too reports one gap twice and less precisely.
      // Verified on production: all 25 kit parents leave, and every genuinely
      // unaccounted component stays.
      filters: [
        { id: "ledgerExpectedQuantity", value: "positive" },
        { id: "location", value: [FILTER_NONE] },
        { id: "servingAsLocations", value: "none" },
        { id: "stockTracked", value: "none" },
        { id: "components", value: "none" },
      ],
      sort: [{ id: "price", desc: true }],
      // Every half of the signal: a filled Expected beside an empty Location,
      // not a bin, not a kit, still undecided on stock tracking.
      // `quantityVariance` is deliberately NOT revealed — on-hand units are
      // NULL for this entire cohort, so it renders `—` on every row, and a dash
      // reads as "unknown" when the actual fact is "none".
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: {
          ledgerExpectedQuantity: true,
          location: true,
          servingAsLocations: true,
          stockTracked: true,
          components: true,
        },
      },
    },
    {
      id: "unlocated-durables",
      label: "Durables not on a shelf",
      description: "Tools and storage the ledger says you own, stocked nowhere",
      // A fast path into `unlocated`, not an authority over it: same question,
      // narrowed to the categories whose members are objects you could go find.
      //
      // ⚠️ It has real false negatives, because `category` is a weak proxy for
      // durability. The disappearance that motivated both views — Milwaukee
      // PACKOUT wall plates, hooks and racks — is categorized `supplies` and
      // `hardware`, so none of it would appear here. Widening to those two
      // categories is not the fix: they also carry the screws and shop
      // consumables this view exists to exclude, and doing so lands you back at
      // ~1,600 rows. When a count here looks reassuring, check `unlocated`.
      filters: [
        { id: "ledgerExpectedQuantity", value: "positive" },
        { id: "location", value: [FILTER_NONE] },
        { id: "servingAsLocations", value: "none" },
        { id: "stockTracked", value: "none" },
        { id: "components", value: "none" },
        {
          id: "categoryFeature",
          value: ["tools", "tool-accessories", "storage"],
        },
      ],
      sort: [{ id: "price", desc: true }],
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: {
          ledgerExpectedQuantity: true,
          location: true,
          servingAsLocations: true,
          stockTracked: true,
          components: true,
          categoryId: true,
          categoryFeature: true,
        },
      },
    },
    {
      id: "consumed-on-projects",
      label: "Consumed on projects",
      description: "Bought for a project, stocked nowhere — likely built in",
      // A fast path into `unlocated`, not an authority over it — the same
      // relationship `unlocated-durables` has, aimed at the opposite half of
      // the backlog. Where that view narrows to things you could go find, this
      // one gathers the material that went INTO the house: the drainage
      // composite buried behind the foundation, the walnut plywood milled into
      // cabinets, the gas line in the ground.
      //
      // Project attachment is the signal, and it is EVIDENCE rather than proof.
      // The cohort is genuinely mixed — a whole Amazon order attributed to a
      // project drags its dog treats and socks along, and a Lutron dimmer sits
      // beside the wire nuts — so this view deliberately does not decide
      // anything. It sorts the backlog so the decision is cheap, and the row
      // still leaves only when `stockTracked` is answered or an InventoryEntry
      // appears. Blanket-sweeping what lands here is the mistake it exists to
      // make visible, not to automate.
      //
      // Costs no new server predicate: `FILTER_ANY` on the related-projects
      // column expands to `projectPresenceFilter: "has"`, which
      // `relatedWhereConditions` already implements generically.
      filters: [
        { id: "ledgerExpectedQuantity", value: "positive" },
        { id: "location", value: [FILTER_NONE] },
        { id: "servingAsLocations", value: "none" },
        { id: "stockTracked", value: "none" },
        { id: "components", value: "none" },
        { id: "related:product.projects", value: [FILTER_ANY] },
      ],
      sort: [{ id: "price", desc: true }],
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        // `related:product.projects` is `defaultVisible: false` in the related
        // registry, and a filtered column that cannot be seen reads as an
        // unexplained row count.
        columnVisibility: {
          ledgerExpectedQuantity: true,
          location: true,
          servingAsLocations: true,
          stockTracked: true,
          components: true,
          "related:product.projects": true,
        },
      },
    },
    {
      id: "kits",
      label: "Kits",
      description: "Products made of other products",
      // A category, not a defect — so no `problem` key. Nothing here converges
      // to zero and nothing here is wrong; buying a combo kit is the normal
      // way these arrive.
      //
      // Earns a view because no other facet finds them: kit categories are
      // scattered across `hardware`, `tools`, `storage`, and `household`, since
      // a kit takes the category of what it contains.
      filters: [{ id: "components", value: "has" }],
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        // `components` is the filtered column and must be revealed. `expected`
        // and `price` come along because a kit's own numbers are the ones that
        // project down to its parts — the kit keeps one Expense, and that row
        // is what gives every component its cost basis and its units.
        columnVisibility: {
          components: true,
          ledgerExpectedQuantity: true,
          price: true,
        },
      },
    },
    {
      id: "unpriced-stocked",
      label: "Stocked but unpriced",
      description: "On a shelf, with no price to value it by",
      // `product_price`'s own `expected` is exactly this pairing (placement
      // 'stock', not a `misc:` bucket) — see checks/product.ts. Unpriced stock
      // is invisible to the location valuation rollup: a null price yields a
      // null entry valuation and the rollup omits it.
      //
      // NARROWER than the old `location: FILTER_ANY` leg: that admitted any
      // placement (including `installed`), while the check's `hasStock` is
      // `placement = 'stock'` only. An installed, unpriced fixture no longer
      // appears here.
      filters: [{ id: "dataGaps", value: ["product_price"] }],
      problem: {
        key: "productsMissingPrice",
        title: "Stocked products with no price",
        description:
          "On a shelf but carrying no price, so they are silently missing from every location's value.",
        emptyMessage: "Every stocked product has a price.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { dataGaps: true, price: true, location: true },
      },
    },
    {
      id: "unpriced-buckets",
      label: "Unpriced buckets",
      description: "`misc:` piles on a shelf, which have no unit price",
      // Split from the view above rather than folded into it: a bucket is a
      // heterogeneous pile and is *expected* to be unpriced, so counting it as
      // a gap leaves that section permanently red. The per-location summary
      // makes the same split (`miscNoPrice`, not `missingPricing`).
      filters: [
        { id: "location", value: [FILTER_ANY] },
        { id: "price", value: "none-bucket" },
      ],
      problem: {
        key: "unvaluedBucketProducts",
        title: "Unvalued misc buckets",
        description:
          "Bucket rows on a shelf with no price. Pricing one is optional — it just makes its location's total less of an underestimate.",
        emptyMessage: "Every misc bucket carries a price.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { price: true, location: true },
      },
    },
    {
      id: "unmapped",
      label: "No way to cost it",
      description: "No price, no USDA key, and no unit mapping",
      // Every path to a cost or a conversion is absent at once: no price to
      // scale, no USDA key to look a food up by, no manual edge to convert
      // through. Any ONE of them would make the product usable, which is why
      // the three are AND-ed rather than reported separately.
      filters: [
        { id: "price", value: "none-real" },
        { id: "food", value: "none" },
        { id: "unitMappingQuality", value: "none" },
        { id: "categoryFeature", value: ["food", FILTER_NONE] },
      ],
      problem: {
        key: "productsWithoutMappings",
        title: "Products with no conversion path",
        description:
          "No price, no USDA key, and no unit mapping — nothing can cost or convert these, so any recipe using them is under-covered.",
        emptyMessage: "Every food product has at least one conversion path.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: {
          price: true,
          food: true,
          unitMappingQuality: true,
          categoryId: true,
          categoryFeature: true,
        },
      },
    },
    {
      id: "over-exited",
      label: "Exit exceeds history",
      description: "Recorded exits exceed the available acquisition history",
      // This view is the `expectedQuantityMax: -1` worklist, and the detector
      // that separately re-derived the same predicate with a grouped HAVING is
      // gone.
      //
      // Deliberately LOOSER than "sold but still stocked", which keys on
      // disposal Purchases. Not an inconsistency — a different question. "Was
      // this sold off entirely?" treats a refund as innocent noise, which on
      // live data it usually is; "do the units balance?" treats a return of 8
      // outlet boxes as 8 real units going back to the store, and most negative
      // lines in this ledger are exactly that, sitting inside a Purchase that
      // nets positive. Requiring a disposal Purchase here missed most of the
      // exited units.
      //
      // The card reads `quantityLedger` off the list row, which carries the
      // unknown-quantity counts field-for-field. They change what the row
      // MEANS: unquantified acquisition lines are data-entry debt (the missing
      // count almost certainly explains the gap), while a fully quantified
      // ledger is a genuine contradiction. Reporting the bare number would
      // flatten those into the same red row.
      filters: [{ id: "ledgerExpectedQuantity", value: "negative" }],
      problem: {
        key: "negativeExpectedQuantity",
        title: "Exits exceed recorded acquisitions",
        description:
          "Recorded exits exceed recorded arrivals. Older acquisitions may predate the ledger, so review the available history before correcting a quantity.",
        emptyMessage: "No product has more recorded exits than acquisitions.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { ledgerExpectedQuantity: true },
      },
    },
  ],
  purchase: [
    {
      id: "needs-review",
      label: "Needs review",
      description: "Stated total the expense lines don't explain",
      // `mismatch` is already the narrow signal: a purchase whose stated total
      // differs from its expense total by more than tolerance AND whose posted
      // refunds don't account for the gap. `refund_adjusted` is the explained
      // case and stays out — this view is the money that doesn't add up.
      filters: [{ id: "reconciliation", value: ["mismatch"] }],
    },
    {
      id: "unsettled",
      label: "No settlement evidence",
      description:
        "Orders with no posted transaction carrying proof of payment",
      // Narrower than "has no transactions": the gap only clears for a POSTED
      // transaction of a settlement kind that either carries a sourceRef or
      // sits on a cash account. An expected refund or an evidence-free row
      // doesn't close it. See `purchaseGapRaw`.
      //
      // This is a large list — a bit under half of all purchases — because it's
      // dominated by Home Depot and Amazon, whose per-visit and per-shipment
      // billing don't line up with per-order purchases. Combine it with the
      // vendor filter to get at the scattered remainder.
      filters: [{ id: "dataGaps", value: ["settlement_reference"] }],
      sort: [{ id: "date", desc: true }],
    },
  ],
  financialTransaction: [
    {
      id: "outstanding",
      label: "Outstanding",
      description: "Expected or pending — money that hasn't moved yet",
      // The owed-money list: an expected refund a vendor never issued, or a
      // credit still in flight. `postedDate` is null on these by construction
      // (posted entries require one), so the sort is really "most recently
      // recorded first".
      filters: [{ id: "status", value: ["expected", "pending"] }],
      sort: [{ id: "createdAt", desc: true }],
    },
    {
      id: "unlinked",
      label: "Not linked to a purchase",
      description: "Settlement evidence with no order attached",
      filters: [{ id: "purchasePresence", value: "none" }],
      sort: [{ id: "postedDate", desc: true }],
    },
  ],
  ingredient: [
    {
      id: "needs-a-product",
      label: "Needs a product",
      description: "Used by one of your own recipes, with nothing to cost it",
      // `ingredient_product`'s own `expected` is "not a sub-recipe, used by
      // one of the household's own recipes" (checks/ingredient.ts) — the
      // cookbook import supplies the overwhelming majority of ingredient
      // usages on this database, and counting them turns ~24 actionable rows
      // into ~1000. A cookbook recipe you can't cost is not a gap in your own
      // data.
      filters: [{ id: "dataGaps", value: ["ingredient_product"] }],
      problem: {
        key: "ingredientsWithoutProduct",
        title: "Ingredients with no product",
        description:
          "Used by a recipe of your own but linked to no product, so nothing can price or convert them. Cookbook-only ingredients are excluded — costing someone else's book isn't the goal.",
        emptyMessage: "Every ingredient your recipes use has a product.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { ownRecipes: true },
      },
    },
    {
      id: "unused-with-product",
      label: "Unused (has product)",
      description: "Used in no recipe, but still linked to a product",
      // `appearsInRecipes: none` already excludes recipe-as-ingredient pointer
      // rows — `ingredientList` applies `isNull(ingredient.recipeId)`
      // unconditionally — so a hit really is an ingredient no live recipe
      // references, which is what the detector's own NOT EXISTS meant.
      filters: [
        { id: "appearsInRecipes", value: "none" },
        { id: "product", value: "has" },
      ],
      problem: {
        key: "unusedIngredientsWithProduct",
        title: "Unused ingredients linked to a product",
        description:
          "Ingredients used in no recipe but still linked to a product. Deleting removes the ingredient and its product(s) — skipped if a product still has inventory.",
        emptyMessage: "No unused product-linked ingredients.",
      },
    },
    {
      id: "unused-no-product",
      label: "Unused",
      description: "Used in no recipe and linked to no product",
      filters: [
        { id: "appearsInRecipes", value: "none" },
        { id: "product", value: "none" },
      ],
      problem: {
        key: "unusedIngredientsWithoutProduct",
        title: "Unused ingredients",
        description:
          "Ingredients used in no recipe and linked to no product — safe to delete.",
        emptyMessage: "No unused ingredients.",
      },
    },
  ],
  location: [
    {
      id: "undescribed",
      label: "No AI description",
      description: "Locations with photos that haven't been described yet",
      // `location_ai_description`'s own `expected` is "has a displayable
      // photo" (checks/location.ts) — describing a location with no photo
      // isn't possible, so without that gate this would select a backlog
      // nothing can drain.
      filters: [{ id: "dataGaps", value: ["location_ai_description"] }],
      problem: {
        key: "locationsWithoutAiDescription",
        title: "Missing AI Descriptions",
        description:
          "Locations with photos that haven't been analyzed by AI yet. Run backfill to generate descriptions for all.",
        emptyMessage: "All locations with photos have AI descriptions.",
      },
      // Both hidden by default on this table, so the view has to reveal them —
      // otherwise it selects rows on a signal nothing on screen explains.
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { aiDescription: true, image: true },
      },
    },
    {
      id: "stale-recounts",
      label: "Overdue a recount",
      description: "Holding stock, not counted in 60 days (or ever)",
      // Inventory never auto-decrements, so nothing but a deliberate recount
      // restores a count's truth — an uncounted bin just drifts. Deliberately
      // looser than the 30-day tint the location page shows: that nudges, this
      // raises a row.
      filters: [
        { id: "inventoryEntries", value: "has" },
        { id: "lastBulkInventory", value: "60" },
      ],
      // Oldest recount first. Never-recounted bins do NOT lead: `buildOrderBy`
      // emits NULLS LAST in both directions, which is the house convention
      // (revisited and kept 2026-07 — empties are found with presence filters,
      // not by sort direction). The detector this replaced ordered `nulls
      // first`; that behaviour is gone deliberately rather than by accident,
      // and a one-column exception is exactly what the convention exists to
      // prevent. They are still fully IN the section — the `IS NULL` half of
      // the predicate is load-bearing — and the count includes them; they just
      // don't fill the card's sample.
      sort: [{ id: "lastBulkInventory", desc: false }],
      problem: {
        key: "staleLocations",
        title: "Locations overdue a recount",
        description:
          "Holding stock whose count hasn't been checked against the shelf in 60 days — or ever.",
        emptyMessage: "Every stocked location has been recounted recently.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { lastBulkInventory: true, inventoryEntries: true },
      },
    },
    {
      id: "empty-leaves",
      label: "Empty",
      description: "Leaf locations holding nothing",
      // Both halves are required. Without `children: none` this matches every
      // shelf whose stock lives in its bins rather than directly on it, which
      // is most of the tree and none of the worklist.
      filters: [
        { id: "inventoryEntries", value: "none" },
        { id: "children", value: "none" },
      ],
      problem: {
        key: "emptyLocations",
        title: "Empty locations",
        description:
          "Leaf locations holding no stock — either not yet itemized, or genuinely empty.",
        emptyMessage: "No empty locations.",
      },
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { children: true, inventoryEntries: true },
      },
    },
  ],
  recipe: [
    {
      id: "no-instructions",
      label: "No instructions",
      description: "Recipes with no written instructions",
      // The source exclusion is spelled as a POSITIVE list plus the `(none)`
      // sentinel, not as a negation: `SourceType` is nullable, a NULL is a
      // legacy hand-entered recipe that must stay visible, and `!= 'Book'`
      // would evaluate UNKNOWN against it and drop it. Book and Notion recipes
      // live elsewhere by design — the text isn't supposed to be here.
      //
      // `recipe-source-complement.unit.test.ts` pins the list to the full
      // enum minus those two, so adding a fifth source can't silently exclude
      // it from this worklist.
      filters: [
        { id: "instructions", value: "none" },
        { id: "sourceType", value: ["Website", "Other", FILTER_NONE] },
      ],
      sort: [{ id: "name", desc: false }],
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { sourceType: true },
      },
    },
  ],
  meal: [
    {
      id: "empty-cooked",
      label: "No linked recipes",
      description: "Cooked meals with no recipe recorded",
      filters: [
        { id: "mealKind", value: ["cooked"] },
        { id: "related:meal.recipes", value: "none" },
      ],
      sort: [{ id: "date", desc: false }],
      // The Recipes column is defaultVisible:false, so reveal the signal this
      // view selects on.
      layout: {
        ...DEFAULT_CURATED_LAYOUT,
        columnVisibility: { "related:meal.recipes": true },
      },
    },
  ],
  inventory: [
    {
      id: "never-verified",
      label: "Never verified",
      description: "Entries whose count has never been checked against a shelf",
      // `inventory_verified`'s own `expected` is `placement = 'stock'`
      // (checks/inventory.ts) — the same guard the inventory list's default
      // `placementFilter` applied. Installed fixtures never get a
      // `verifiedAt` (nobody recounts a wired-in dimmer), so including them
      // would make this list permanently undrainable.
      filters: [{ id: "dataGaps", value: ["inventory_verified"] }],
      // Oldest first — the longest-unverified entries lead.
      sort: [{ id: "createdAt", desc: false }],
      problem: {
        key: "neverVerifiedInventory",
        title: "Inventory never confirmed by a recount",
        description:
          "Entries whose count has never been checked against the shelf (oldest first). Recount the location they live in to clear them. `verifiedAt` only started being stamped when audit sessions landed, so most of the inventory starts here — this is a backlog to work down, not a list of mistakes.",
        emptyMessage: "Every inventory entry has been verified at least once.",
      },
    },
  ],
  importRun: [
    {
      id: "imports",
      label: "Imports",
      description: "Account syncs, validations, enrichments and photo batches",
      filters: [
        {
          id: "purpose",
          value: [
            "account_sync",
            "purchase_validation",
            "product_enrichment",
            "photo_inventory",
          ],
        },
      ],
    },
    {
      id: "ai-work",
      label: "AI work",
      description: "Jev suggestion passes, AI actions and background AI work",
      filters: [
        { id: "purpose", value: ["ai_suggest", "ai_action", "background"] },
      ],
    },
  ],
  wish: [
    {
      id: "hide-acquired",
      label: "Hide acquired",
      description: "Only items still on the list",
      filters: [{ id: "acquiredAt", value: "false" }],
    },
  ],
});

const isEntity = (value: string): value is Entity =>
  Object.prototype.hasOwnProperty.call(viewManifest, value);
const isManifestEntity = (value: string): value is keyof typeof viewManifest =>
  Object.prototype.hasOwnProperty.call(viewManifest, value);
type ViewFilterValue = string | string[] | undefined;
const viewFilterValue = <T>(value: T): ViewFilterValue => {
  if (Array.isArray(value)) {
    return value.every((item): item is string => typeof item === "string")
      ? value
      : undefined;
  }
  return z.string().safeParse(value).data;
};

/** A view that also declares a Problems section, paired with its entity. */
export interface ViewProblemDeclaration {
  entity: Entity;
  viewId: string;
  sort: ViewDefinition["sort"];
  problem: ProblemQuery;
}

/**
 * Every problem-backed view, flattened.
 *
 * The single roster the Problems service iterates to run its list queries and
 * and the canonical Problem Query registry. Derived from `viewManifest` rather than
 * hand-listed, so declaring a view IS declaring the section — there is no
 * second place to register it and therefore no way for the two to disagree.
 */
export function viewProblemDeclarations(): ViewProblemDeclaration[] {
  const declarations = Object.entries(viewManifest).flatMap(
    ([entity, views]) =>
      !isEntity(entity)
        ? []
        : (views ?? []).flatMap((view) => {
            if (!("problem" in view) || !view.problem) return [];
            const problem = view.problem;
            if (!problem) return [];
            const viewSort = "sort" in view ? view.sort : undefined;
            const viewLayout = "layout" in view ? view.layout : undefined;
            const source: EntityProblemSource = {
              kind: "entity",
              entity,
              filters: view.filters,
            };
            if (viewSort) source.sort = viewSort;
            if (viewLayout?.columnVisibility) {
              source.columnVisibility = viewLayout.columnVisibility;
            }
            return [
              {
                entity,
                viewId: view.id,
                sort: viewSort,
                problem: defineProblem({
                  ...problem,
                  problemClass: PROBLEM_CLASS[problem.key],
                  executionLane: "views",
                  continuation: { kind: "entity-list" },
                  freshness: { kind: "live" },
                  source,
                }),
              },
            ];
          }),
  );
  validateProblemQueries(declarations.map(({ problem }) => problem));
  return declarations;
}

/**
 * Exact entity Problems that are not named saved views. They remain ordinary
 * filter assemblies; a dedicated view would only add a redundant tab to the
 * ledger while the Problems page is their intended entry point.
 */
const standaloneEntityProblems = [
  defineProblem({
    key: "purchaseFinancialSettlementMismatches",
    problemClass: PROBLEM_CLASS.purchaseFinancialSettlementMismatches,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Purchase financial settlement mismatches",
    description:
      "Purchase settlement evidence disagrees with the incurred expense total.",
    emptyMessage: "Every comparable purchase settlement reconciles.",
    source: {
      kind: "entity" as const,
      entity: "purchase" as const,
      filters: [{ id: "financialReconciliation", value: "mismatch" }],
    },
  }),
  defineProblem({
    key: "financialTransactionAllocationDefects",
    problemClass: PROBLEM_CLASS.financialTransactionAllocationDefects,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Financial transaction allocation defects",
    description:
      "A transaction's settlement split doesn't add up, or points the wrong way — the amounts don't match the transaction, or a credit is recorded as a charge.",
    emptyMessage: "Every settlement allocation is internally consistent.",
    source: {
      kind: "entity" as const,
      entity: "financialTransaction" as const,
      filters: [{ id: "allocationIntegrity", value: "defect" }],
      sort: [{ id: "postedDate", desc: true }],
    },
  }),
  defineProblem({
    key: "purchasesNotReconciling",
    problemClass: PROBLEM_CLASS.purchasesNotReconciling,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Purchases whose totals do not reconcile",
    description:
      "What a receipt says it totalled and what its recorded lines add up to differ by more than rounding.",
    emptyMessage: "Every purchase reconciles with its expense lines.",
    source: {
      kind: "entity" as const,
      entity: "purchase" as const,
      filters: [{ id: "reconciliation", value: ["mismatch"] }],
      sort: [{ id: "reconciliationGap", desc: true }],
    },
  }),
  defineProblem({
    key: "unlinkedExitExpenses",
    problemClass: PROBLEM_CLASS.unlinkedExitExpenses,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Productless lines in disposal purchases",
    description:
      "Negative itemized principal lines without a product link. Some describe intentionally untracked goods; review them as provenance coverage.",
    emptyMessage:
      "No itemized principal disposal line is missing a product link.",
    source: {
      kind: "entity" as const,
      entity: "expense" as const,
      filters: [
        { id: "future", value: "false" },
        { id: "costSign", value: "negative" },
        { id: "lineKind", value: ["principal"] },
        { id: "lineBasis", value: ["item_line"] },
        { id: "productId", value: "none" },
        { id: "disposalPurchasePresenceFilter", value: "has" },
      ],
      sort: [{ id: "date", desc: true }],
    },
  }),
  defineProblem({
    key: "purchaselessExitExpenses",
    problemClass: PROBLEM_CLASS.purchaselessExitExpenses,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Possible exits without a purchase",
    description:
      "Money that came back in — a sale or refund — recorded against neither a product nor an order, so there's no telling what left the house.",
    emptyMessage: "Every recorded sale or refund traces back to an order.",
    source: {
      kind: "entity" as const,
      entity: "expense" as const,
      filters: [
        { id: "future", value: "false" },
        { id: "costSign", value: "negative" },
        { id: "productId", value: "none" },
        { id: "purchaseId", value: [FILTER_NONE] },
        { id: "lineKind", value: ["principal"] },
        { id: "lineBasis", value: ["item_line"] },
      ],
      sort: [{ id: "date", desc: true }],
    },
  }),
  defineProblem({
    key: "pastDuePlannedExpenses",
    problemClass: PROBLEM_CLASS.pastDuePlannedExpenses,
    executionLane: "tracker",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Past-due planned expenses",
    description: "Planned expenses dated before the household's current day.",
    emptyMessage: "No planned expenses are past due.",
    source: {
      kind: "entity" as const,
      entity: "expense" as const,
      filters: [
        { id: "future", value: "true" },
        { id: "dateRelative", value: "beforeToday" },
      ],
      sort: [{ id: "date", desc: false }],
    },
  }),
  defineProblem({
    key: "productsWithNoImages",
    problemClass: PROBLEM_CLASS.productsWithNoImages,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Products with no images",
    // `product_image`'s own `expected` is "has inventory" (checks/product.ts)
    // — STOCKED products, regardless of ingredient link. NARROWER than the old
    // predicate for a non-stocked, non-ingredient product with no image (now
    // excluded), and WIDER for a stocked product that IS an ingredient (now
    // included, where it used to be excluded). See the migration note in this
    // lane's report for the population delta.
    description: "Non-ingredient products with no displayable image.",
    emptyMessage: "Every standalone product has an image.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [{ id: "dataGaps", value: ["product_image"] }],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { image: true, ingredient: true },
    },
  }),
  defineProblem({
    key: "duplicateInventory",
    problemClass: PROBLEM_CLASS.duplicateInventory,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Products recorded twice",
    description:
      "Single-unit products duplicated within stock or installed placement.",
    emptyMessage: "No single-unit products are duplicated within a placement.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [
        { id: "inventoryMultiplicity", value: "duplicate_within_placement" },
      ],
      sort: [{ id: "name", desc: false }],
      columnVisibility: { ledgerExpectedQuantity: true, location: true },
    },
  }),
  defineProblem({
    key: "soldButStillStocked",
    problemClass: PROBLEM_CLASS.soldButStillStocked,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Disposed but still on hand",
    description:
      "A recorded disposal closed the known quantity while inventory remains on hand.",
    emptyMessage: "No disposed products remain in inventory.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [
        { id: "ownershipReconciliation", value: "disposed_still_on_hand" },
      ],
      sort: [{ id: "updatedAt", desc: true }],
      columnVisibility: { ledgerExpectedQuantity: true, location: true },
    },
  }),
  defineProblem({
    key: "kitsCountedTwice",
    problemClass: PROBLEM_CLASS.kitsCountedTwice,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Kits counted twice",
    description:
      "Stocked under its own name and by its components, together accounting for more units than were bought.",
    emptyMessage: "No kit is counted twice.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [{ id: "kitAccounting", value: "double_counted" }],
      sort: [{ id: "updatedAt", desc: true }],
      columnVisibility: {
        ledgerExpectedQuantity: true,
        location: true,
        components: true,
      },
    },
  }),
  defineProblem({
    key: "unknownParkedItems",
    problemClass: PROBLEM_CLASS.unknownParkedItems,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Items parked in Unknown",
    description: "Inventory in the household-wide Unknown location.",
    emptyMessage: "No inventory is parked in Unknown.",
    source: {
      kind: "entity" as const,
      entity: "inventory" as const,
      filters: [
        { id: "locationRole", value: "global_unknown" },
        { id: "placement", value: "all" },
      ],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { location: true, placement: true },
    },
  }),
  defineProblem({
    key: "inventoryWithoutPricePath",
    problemClass: PROBLEM_CLASS.inventoryWithoutPricePath,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Inventory without a price path",
    description:
      "Inventory whose product has a price but whose stored unit cannot reach it.",
    emptyMessage: "Every priced product can value its inventory.",
    source: {
      kind: "entity" as const,
      entity: "inventory" as const,
      filters: [
        { id: "valuationStatus", value: "missing_with_priced_product" },
        { id: "placement", value: "all" },
      ],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { valuation: true, product: true },
    },
  }),
  defineProblem({
    key: "understatedCostMeals",
    problemClass: PROBLEM_CLASS.understatedCostMeals,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Meals with understated recipe cost",
    description:
      "Meals whose live recipes have incomplete priced ingredient coverage.",
    emptyMessage: "Every meal has complete recipe cost coverage.",
    source: {
      kind: "entity" as const,
      entity: "meal" as const,
      filters: [{ id: "recipeCostCoverage", value: "understated" }],
      sort: [{ id: "date", desc: false }],
      columnVisibility: { recipes: true },
    },
  }),
] as const satisfies readonly ProblemQuery[];

/** All exact entity-grain Problem declarations currently migrated. */
export function entityProblemDeclarations(): readonly ProblemQuery[] {
  const definitions = [
    ...viewProblemDeclarations().map(({ problem }) => problem),
    ...standaloneEntityProblems,
  ];
  validateProblemQueries(definitions);
  return definitions;
}

export function viewsForEntity(entity: Entity | undefined): ViewDefinition[] {
  return entity && isManifestEntity(entity) ? (viewManifest[entity] ?? []) : [];
}

/**
 * True when `columnFilters` and `sorting` match this view exactly.
 *
 * Exact, not "contains": a view is a starting point, not a mode, so
 * hand-editing any filter simply drops the checkmark. That's the honest
 * readout — the alternative would keep a view lit while showing different
 * rows.
 */
export function isViewActive<T>(
  view: ViewDefinition,
  columnFilters: ReadonlyArray<{ id: string; value: T | ViewFilterValue }>,
  sorting: ReadonlyArray<{ id: string; desc: boolean }>,
): boolean {
  if (columnFilters.length !== view.filters.length) return false;

  const sameValue = (a: string | string[] | undefined, b: string | string[]) =>
    Array.isArray(b)
      ? Array.isArray(a) &&
        a.length === b.length &&
        b.every((v, i) => a[i] === v)
      : a === b;

  const filtersMatch = view.filters.every((f) =>
    sameValue(
      viewFilterValue(columnFilters.find((c) => c.id === f.id)?.value),
      f.value,
    ),
  );
  if (!filtersMatch) return false;

  if (!view.sort) return true;
  return (
    sorting.length === view.sort.length &&
    view.sort.every(
      (s, i) => sorting[i]?.id === s.id && sorting[i]?.desc === s.desc,
    )
  );
}
