import type { Entity } from "@cubby/schemas/entity";
import type { ProblemKey } from "@cubby/schemas/problems";
import {
  LIVE_PROJECT_STATUSES,
  taskStatusValues,
} from "@cubby/schemas/project";
import { FILTER_NONE } from "./filters";

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

/**
 * Marks a view as ALSO being a Problems section, so one declaration produces
 * the saved view, the shareable URL, and the Problems card.
 *
 * This is the anti-divergence move. Several detectors used to re-write in SQL a
 * predicate the entity's list already expressed as filters — and the schemas
 * said so out loud: `productFilterFields.expectedQuantityMax` documents
 * `-1` as "the 'sold or returned more than was ever bought' worklist", which
 * is exactly what `findProductsWithNegativeExpectedQuantity` re-derived with a
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
  /**
   * The same predicate in the server's `*Filters` vocabulary.
   *
   * A projection of `filters`, never an independent statement of it:
   * `view-manifest.unit.test.tsx` resolves `filters` through the real manifest
   * with `buildFiltersFromManifest` and asserts deep equality with this, so the
   * two cannot drift — a mismatch fails with the exact expected object.
   *
   * It exists because the server needs these filters and the resolver's input,
   * `filter-manifest.tsx`, reaches into `~/app/**` for its icon-bearing option
   * lists. Importing that graph into the Worker to re-derive fourteen static
   * objects is a worse trade than a mechanically-pinned projection.
   */
  serverFilters: Record<string, unknown>;
}

export interface ViewDefinition {
  id: string;
  label: string;
  description: string;
  filters: ViewFilter[];
  sort?: Array<{ id: string; desc: boolean }>;
  /**
   * Columns to force on (or off) when the view is applied, by `columnId`.
   *
   * A view that selects rows on a signal the table hides by default lands the
   * operator on a filtered list with no column explaining *why* those rows are
   * there — which is how a worklist becomes a mystery. Omitted keys are left
   * at whatever the user already had, so this reveals what the view is about
   * without resetting their layout.
   *
   * This DOES persist, and deliberately so. On a list table `useEntityList`
   * wires `useTableColumnVisibility` in as the controlled handler, so the
   * reveal lands in `table-columns:{entity}` like any manual toggle and
   * survives a reload — you keep the columns while you work the list, and
   * turning them back off sticks the same way. Anything narrower would mean
   * fighting the controlled-visibility path to make a column vanish on
   * navigation, which is a worse surprise than an extra column.
   */
  columnVisibility?: Record<string, boolean>;
  problem?: ViewProblem;
}

/**
 * Saved views select records; renderer tabs never do.
 *
 * A view may additionally declare a `problem`, which makes it a Problems
 * section too. Not every detector can become one — a predicate the flat filter
 * vocabulary can't express (no OR-tree, no negation, no HAVING over groups),
 * one whose bound is relative to now (a static `serverFilters` can't hold a
 * cutoff date), or one whose correctness rests on a compile-time weld a data
 * declaration can't carry. `findOrphanedProducts` is the third kind and says so
 * at its own definition.
 */
export const viewManifest: Partial<Record<Entity, ViewDefinition[]>> = {
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
        { id: "project", value: [FILTER_NONE] },
        { id: "parentTask", value: [FILTER_NONE] },
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
      filters: [{ id: "project", value: [FILTER_NONE] }],
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
      // The Purchase column retains the historical `vendor` id so existing
      // vendor URLs, sorting, and mixed vendor-or-none filters keep working.
      filters: [{ id: "vendor", value: [FILTER_NONE] }],
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
        { id: "product", value: "none" },
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
        { id: "product", value: "none" },
        { id: "vendor", value: [FILTER_NONE] },
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
        { id: "product", value: "has" },
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
      columnVisibility: { productQuantity: true },
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
      // A worklist, not a defect list: it never converges to zero, which is why
      // it lives here rather than as a Problems section. The genuine defect —
      // more units gone than ever arrived — IS a Problems section
      // (`negativeExpectedQuantity`), and that one does converge.
      filters: [{ id: "quantityVariance", value: "mismatched" }],
      // Both hidden by default on a table this wide, so the view has to reveal
      // them — otherwise it selects rows on a signal nothing on screen explains.
      columnVisibility: { expectedQuantity: true, quantityVariance: true },
    },
    {
      id: "unknown-quantities",
      label: "Missing quantities",
      description: "Products whose expense lines don't establish a count",
      // The data-entry backlog behind the `+N?` cue: a receipt that proves the
      // cost but not the count leaves the expected quantity understated, and
      // nothing infers one (a nullable quantity is never read as 1).
      filters: [{ id: "expectedQuantity", value: "unknown" }],
      columnVisibility: { expectedQuantity: true },
    },
    {
      id: "unlocated",
      label: "Not on a shelf",
      description: "Bought, never sold, but stocked nowhere",
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
      filters: [
        { id: "expectedQuantity", value: "positive" },
        { id: "location", value: [FILTER_NONE] },
        { id: "stockTracked", value: "none" },
      ],
      sort: [{ id: "price", desc: true }],
      // All three halves of the signal: a filled Expected beside an empty
      // Location, still undecided on stock tracking. `quantityVariance` is
      // deliberately NOT revealed — on-hand units are NULL for this entire
      // cohort, so it renders `—` on every row, and a dash reads as "unknown"
      // when the actual fact is "none".
      columnVisibility: {
        expectedQuantity: true,
        location: true,
        stockTracked: true,
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
        { id: "expectedQuantity", value: "positive" },
        { id: "location", value: [FILTER_NONE] },
        { id: "stockTracked", value: "none" },
        { id: "category", value: ["tools", "tool-accessories", "storage"] },
      ],
      sort: [{ id: "price", desc: true }],
      columnVisibility: {
        expectedQuantity: true,
        location: true,
        stockTracked: true,
        category: true,
      },
    },
    {
      id: "over-exited",
      label: "Sold more than bought",
      description: "More units gone than the ledger can account for buying",
      // The schema already calls `expectedQuantityMax: -1` "a real data defect,
      // and the reason this is not clamped at zero" — this view is that
      // sentence, and the detector that separately re-derived it with a grouped
      // HAVING is gone.
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
      filters: [{ id: "expectedQuantity", value: "negative" }],
      problem: {
        key: "negativeExpectedQuantity",
        title: "More units gone than acquired",
        description:
          "The ledger says more units left than ever arrived. Usually a missing acquisition line or a quantity typed on the wrong row.",
        emptyMessage: "No product has exited more units than it acquired.",
        serverFilters: { expectedQuantityMax: -1 },
      },
      columnVisibility: { expectedQuantity: true },
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
        serverFilters: {
          recipePresenceFilter: "none",
          productPresenceFilter: "has",
        },
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
        serverFilters: {
          recipePresenceFilter: "none",
          productPresenceFilter: "none",
        },
      },
    },
  ],
  location: [
    {
      id: "undescribed",
      label: "No AI description",
      description: "Locations with photos that haven't been described yet",
      // `image: has` is not decoration: describing a location with no photo
      // isn't possible, so without it this selects a backlog nothing can drain.
      filters: [
        { id: "image", value: "has" },
        { id: "aiDescription", value: "none" },
      ],
      problem: {
        key: "locationsWithoutAiDescription",
        title: "Missing AI Descriptions",
        description:
          "Locations with photos that haven't been analyzed by AI yet. Run backfill to generate descriptions for all.",
        emptyMessage: "All locations with photos have AI descriptions.",
        serverFilters: {
          imagePresenceFilter: "has",
          aiDescriptionPresenceFilter: "none",
        },
      },
      // Both hidden by default on this table, so the view has to reveal them —
      // otherwise it selects rows on a signal nothing on screen explains.
      columnVisibility: { aiDescription: true, image: true },
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
        // The Inventory column is a COUNT range, not a presence toggle, so
        // "none" expands to a bound rather than a sentinel. Same predicate
        // either way: `directItemCountMax: 0` is resolved against the live,
        // stock-only entry set (live product included), which is the detector's
        // `notExists(... stockOnly())` plus the product-liveness guard the list
        // already applies so the count matches what the cell renders.
        serverFilters: {
          directItemCountMax: 0,
          childPresenceFilter: "none",
        },
      },
      columnVisibility: { children: true, inventoryEntries: true },
    },
  ],
  inventory: [
    {
      id: "never-verified",
      label: "Never verified",
      description: "Entries whose count has never been checked against a shelf",
      // No placement filter, deliberately: the inventory list defaults an
      // omitted `placementFilter` to `"stock"`, which is exactly the
      // `stockOnly()` guard the detector carried. Installed fixtures never get
      // a `verifiedAt` (nobody recounts a wired-in dimmer), so including them
      // would make this list permanently undrainable.
      filters: [{ id: "verifiedAt", value: "none" }],
      // Oldest first — the longest-unverified entries lead.
      sort: [{ id: "createdAt", desc: false }],
      problem: {
        key: "neverVerifiedInventory",
        title: "Inventory never confirmed by a recount",
        description:
          "Entries whose count has never been checked against the shelf (oldest first). Recount the location they live in to clear them. `verifiedAt` only started being stamped when audit sessions landed, so most of the inventory starts here — this is a backlog to work down, not a list of mistakes.",
        emptyMessage: "Every inventory entry has been verified at least once.",
        serverFilters: { verifiedPresenceFilter: "none" },
      },
    },
  ],
  wish: [
    {
      id: "hide-acquired",
      label: "Hide acquired",
      description: "Only items still on the list",
      filters: [{ id: "acquired", value: "false" }],
    },
  ],
};

/** A view that also declares a Problems section, paired with its entity. */
export interface ViewProblemDeclaration {
  entity: Entity;
  viewId: string;
  sort: ViewDefinition["sort"];
  problem: ViewProblem;
}

/**
 * Every problem-backed view, flattened.
 *
 * The single roster the Problems service iterates to run its list queries and
 * the pinning test iterates to prove each `serverFilters` really is the
 * projection of its `filters`. Derived from `viewManifest` rather than
 * hand-listed, so declaring a view IS declaring the section — there is no
 * second place to register it and therefore no way for the two to disagree.
 */
export function viewProblemDeclarations(): ViewProblemDeclaration[] {
  return Object.entries(viewManifest).flatMap(([entity, views]) =>
    (views ?? [])
      .filter((view) => view.problem)
      .map((view) => ({
        entity: entity as Entity,
        viewId: view.id,
        sort: view.sort,
        // Narrowed by the filter above; the predicate can't tell TS that.
        problem: view.problem as ViewProblem,
      })),
  );
}

export function viewsForEntity(entity: Entity | undefined): ViewDefinition[] {
  return (entity && viewManifest[entity]) ?? [];
}

/**
 * True when `columnFilters` and `sorting` match this view exactly.
 *
 * Exact, not "contains": a view is a starting point, not a mode, so
 * hand-editing any filter simply drops the checkmark. That's the honest
 * readout — the alternative would keep a view lit while showing different
 * rows.
 */
export function isViewActive(
  view: ViewDefinition,
  columnFilters: ReadonlyArray<{ id: string; value: unknown }>,
  sorting: ReadonlyArray<{ id: string; desc: boolean }>,
): boolean {
  if (columnFilters.length !== view.filters.length) return false;

  const sameValue = (a: unknown, b: string | string[]) =>
    Array.isArray(b)
      ? Array.isArray(a) &&
        a.length === b.length &&
        b.every((v, i) => a[i] === v)
      : a === b;

  const filtersMatch = view.filters.every((f) =>
    sameValue(columnFilters.find((c) => c.id === f.id)?.value, f.value),
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
