import type { Entity } from "@cubby/schemas/entity";
import { problemClasses as PROBLEM_CLASS } from "@cubby/schemas/entity-roster";
import type { homePinnedViews } from "@cubby/schemas/entity-roster";
import type { ListGroupBy } from "@cubby/schemas/pagination";
import type { ProblemKey } from "@cubby/schemas/problems";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { entityMetadata, type EntityMetadataFor } from "~/entity/metadata";

/**
 * Saved views: a named starting point of filters + sort for a list table.
 *
 * A view is a *declaration* (`presentation.list.savedViews` on the entity,
 * checked at generation time against the entity's filter descriptors and list
 * columns): applying one sets real column-filter state, which the existing
 * `useTableState` write-back effect serializes to the URL. So a view and a
 * shared link are the same thing by construction, the header controls stay
 * live (editing one just drops the active checkmark), and no filter is
 * applied that the chips can't show.
 *
 * This module adapts the requested slice and compares active table state.
 * The server Problems owner consumes aggregate canonical declarations from
 * view-problems; ordinary browser views never initialize that roster.
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

/**
 * Marks a view as ALSO being a Problems section, so one declaration produces
 * the saved view, the shareable URL, and the Problems card. The card's rows
 * come from the entity's ordinary list procedure, so converting a detector
 * deletes SQL rather than moving it.
 */
interface ViewProblem {
  /** Keeps `PROBLEM_CLASS` exhaustive — the class itself stays on the schema
   *  side, because defect-vs-coverage is about meaning, not about selection. */
  key: ProblemKey;
  title: string;
  description: string;
  emptyMessage: string;
}

/**
 * A guided pass a view leads into, offered beside the view in the saved-views
 * menu. A declaration, not a route: the menu owns the mapping from `kind` to
 * a typed link.
 */
interface ViewFlow {
  kind: "shelf-triage";
  label: string;
}

export interface ViewDefinition {
  /** Alarm count derived from the declared Problems classification. */
  tone?: "destructive" | "warning";
  id: string;
  label: string;
  description: string;
  filters: ViewFilter[];
  /** The guided pass this view's rows can be worked through. */
  flow?: ViewFlow;
  sort?: Array<{ id: string; desc: boolean }>;
  /** Optional curated layout. Applying it replaces every layout slice after
   * normalization against the table's current code-defined columns. */
  layout?: ViewLayout;
  problem?: ViewProblem;
  /** The list view (`?view=`) the saved view opens in. */
  view?: string;
  /** The `model.grouping` choice (`?groupBy=`) the saved view opens with. */
  groupBy?: ListGroupBy[];
  /** A shortcut on another surface (the home "Your views" row). */
  pin?: { surface: "home"; order: number };
}

const isProblemKey = (key: string): key is ProblemKey =>
  Object.hasOwn(PROBLEM_CLASS, key);

const problemKey = (key: string): ProblemKey => {
  if (!isProblemKey(key))
    throw new Error(`Saved view names unknown Problem key ${key}.`);
  return key;
};

type DeclaredView =
  | EntityMetadataFor<Entity>["summary"]["list"]["savedViews"][number]
  | (typeof homePinnedViews)[number]["view"];

export const toViewDefinition = (view: DeclaredView): ViewDefinition => {
  const definition: ViewDefinition = {
    id: view.id,
    label: view.label,
    description: view.description,
    filters: view.filters.map(({ id, value }) => ({
      id,
      value: typeof value === "string" ? value : [...value],
    })),
  };
  if (view.flow) definition.flow = { ...view.flow };
  if (view.sort) definition.sort = view.sort.map((entry) => ({ ...entry }));
  if (view.layout)
    definition.layout = {
      columnOrder: [],
      columnPinning: { start: [], end: [] },
      columnSizing: {},
      columnVisibility: { ...view.layout.columnVisibility },
    };
  if (view.problem) {
    const key = problemKey(view.problem.key);
    definition.problem = { ...view.problem, key };
    definition.tone =
      PROBLEM_CLASS[key] === "defect" ? "destructive" : "warning";
  }
  if (view.view) definition.view = view.view;
  if (view.groupBy)
    definition.groupBy = view.groupBy.map((group) => ({ ...group }));
  if (view.pin) definition.pin = { ...view.pin };
  return definition;
};

type ViewFilterValue = string | string[] | undefined;
const viewFilterValue = <T>(value: T): ViewFilterValue => {
  if (Array.isArray(value)) {
    return value.every((item): item is string => typeof item === "string")
      ? value
      : undefined;
  }
  return z.string().safeParse(value).data;
};

export function viewsForEntity(
  queryClient: QueryClient,
  entity: Entity | undefined,
): ViewDefinition[] {
  return entity
    ? entityMetadata(queryClient, entity).summary.list.savedViews.map(
        toViewDefinition,
      )
    : [];
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
