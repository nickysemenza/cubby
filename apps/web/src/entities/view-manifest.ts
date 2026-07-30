import type { Entity } from "@cubby/schemas/entity";
import { FILTER_NONE } from "./filters";

/**
 * Hardcoded saved views: a named starting point of filters + sort for a list
 * table.
 *
 * These used to be view-switcher tabs whose filters lived in a
 * `Partial<ExpenseFilters>` spread into `useEntityList`'s `extraFilters`.
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
  /** A `columnId` of a filter spec declared for this entity. */
  id: string;
  value: string | string[];
}

export interface ViewDefinition {
  /** Stable id — also the legacy `?view=` value it replaces, where one exists. */
  id: string;
  label: string;
  /** One-line description of what the view selects, shown under the label. */
  description: string;
  filters: ViewFilter[];
  /** TanStack `SortingState`; omitted means "leave the current sort alone". */
  sort?: Array<{ id: string; desc: boolean }>;
}

/**
 * Only `expense` has views today. Tasks' `history` tab is deliberately NOT
 * here: it pins `completion: "done"`, a schema enum with no column and no
 * manifest spec, so it isn't expressible as column-filter state without
 * inventing a column for it. It keeps its tab.
 */
export const viewManifest: Partial<Record<Entity, ViewDefinition[]>> = {
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
