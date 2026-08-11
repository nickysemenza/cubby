import type { Entity } from "@cubby/schemas/entity";
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
}

/** Saved views select records; renderer tabs never do. */
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
      // server predicate, only these two existing filters combined.
      //
      // Deliberately unscoped, and it does NOT converge: inventory never
      // auto-decrements (a tenet), so every consumable ever bought stays
      // "owned" here forever — 4,462 products on production, over a third of
      // them food. No field separates durable from consumable, so rather than
      // guess with a category predicate this sorts by price and lets the
      // operator narrow with the live chips. The top of the list is where the
      // money is; `unlocated-durables` below is the shortcut, not the answer.
      filters: [
        { id: "expectedQuantity", value: "positive" },
        { id: "location", value: [FILTER_NONE] },
      ],
      sort: [{ id: "price", desc: true }],
      // Both halves of the signal: a filled Expected beside an empty Location
      // is the whole story ("three of these, nowhere"). `quantityVariance` is
      // deliberately NOT revealed — on-hand units are NULL for this entire
      // cohort, so it renders `—` on every row, and a dash reads as "unknown"
      // when the actual fact is "none".
      columnVisibility: { expectedQuantity: true, location: true },
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
        { id: "category", value: ["tools", "tool-accessories", "storage"] },
      ],
      sort: [{ id: "price", desc: true }],
      columnVisibility: {
        expectedQuantity: true,
        location: true,
        category: true,
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
  wish: [
    {
      id: "hide-acquired",
      label: "Hide acquired",
      description: "Only items still on the list",
      filters: [{ id: "acquired", value: "false" }],
    },
  ],
};

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
