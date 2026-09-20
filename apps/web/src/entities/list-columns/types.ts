import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { CellData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { ListWorkbenchProps } from "~/app/_components/data-table/ListWorkbench";
import type {
  createCubbyColumnCollection,
  CubbyColumnDef,
  CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import type { ListSlotProps } from "~/app/_components/entity-list/list-slot-types";
import type {
  BaseListRow,
  EntityListTreeConfig,
  UseEntityListOptions,
  UseEntityListReturn,
} from "~/app/_components/hooks/useEntityList";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";

/**
 * What the generic list hands an override module: the route's validated
 * search (the entity's generated schema) and a merge-navigate over it.
 */
export type ListOverrideContext = ListSlotProps;

/** The `useEntityList` options an override module may contribute. */
type ListOverrideListOptions<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow,
> = Partial<
  Pick<
    UseEntityListOptions<TData, TFilters, TRow>,
    | "deletable"
    | "deleteEmptyLabel"
    | "extraActions"
    | "filterOptions"
    | "getMappings"
    | "groupConfig"
    | "hiddenFilterColumns"
    | "initialColumnVisibility"
    | "nameClassName"
    | "nameEditable"
    | "nameSuffix"
    | "preview"
    | "subject"
    | "tableStateOptions"
  >
>;

/** The `ListWorkbench` props an override module may contribute. */
export type ListOverrideWorkbenchProps<TData extends BaseListRow> = Partial<
  Pick<
    ListWorkbenchProps<TData>,
    | "contextualStatus"
    | "filterOptionHints"
    | "getMobileDetailsHref"
    | "getRowClassName"
    | "showCellSelectionStats"
    | "verticalAlign"
  >
>;

/**
 * One entity's hand-written list pieces — everything the declaration cannot
 * say: specialized cell renderers for declared columns (`overrides`), the
 * third-bucket columns and their interleaving (`compose`), tree nesting,
 * runtime filter picklists, dialogs, and chrome above/below the table.
 *
 * `use` is a hook. That is sound because the generic list mounts one module
 * per entity and the entity is fixed for the component's lifetime, the same
 * way the action registry's `use()` hooks are.
 */
export interface EntityListOverrideResult<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow = TData,
> {
  /**
   * Declared-column renderers matched by column id; handed to
   * `createEntityDisplayColumns`, which rejects an id the entity does not
   * declare. Must be referentially stable (built in a `useMemo`).
   */
  overrides?: CubbyColumnCollection<TData>;
  /**
   * Adds the columns outside the field model (relations, client-hydrated
   * values, filter-hosting projections) around the declared ones. Receives
   * the compiled declared collection; returns the complete one. Stable.
   */
  compose?: (
    declared: CubbyColumnCollection<TData>,
  ) => CubbyColumnCollection<TData>;
  tree?: EntityListTreeConfig<TData, TRow>;
  list?: ListOverrideListOptions<TData, TFilters, TRow>;
  /**
   * Workbench chrome that reads the mounted list (a summary of its rows, facet
   * hints keyed on its filters). A hook: the generic list calls it once per
   * render after the list hook, in a fixed order.
   */
  useWorkbench?: (
    list: UseEntityListReturn<TData, TFilters, TRow>,
  ) => ListOverrideWorkbenchProps<TData>;
  /**
   * A row source other than the entity's generic list operation, for an
   * entity that has no generated list (image).
   */
  source?: ListQueryOptionsFn<TFilters, TRow>;
  /**
   * Caller-provided rows for an entity whose read is one unpaginated
   * projection (cookbook); the generic list then pages client-side. Must be
   * referentially stable.
   */
  client?: { data: TData[]; isLoading?: boolean; error?: unknown };
  /** Chrome rendered above the table, given the mounted list model. */
  above?: (list: UseEntityListReturn<TData, TFilters, TRow>) => ReactNode;
  /** Dialogs and other chrome rendered under the table. */
  below?: (list: UseEntityListReturn<TData, TFilters, TRow>) => ReactNode;
  /** A provider the whole list body renders inside. */
  wrap?: (
    children: ReactNode,
    list: UseEntityListReturn<TData, TFilters, TRow>,
  ) => ReactNode;
}

export interface EntityListOverride<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow = TData,
> {
  /**
   * `client` pages `use().client` rows in the browser instead of running the
   * entity's list operation. Static (not part of `use`) so the generic list
   * can pick its hook path before any hook runs.
   */
  mode?: "server" | "client";
  use: (
    context: ListOverrideContext,
  ) => EntityListOverrideResult<TData, TFilters, TRow>;
}

/** The registry's widened view; every module is typed exactly at its own file. */
export type AnyEntityListOverride = EntityListOverride<
  BaseListRow,
  object,
  BaseListRow
>;

/**
 * Widen a typed module for the registry. The one cast the registry needs:
 * a module's `use` returns columns and callbacks typed to its own row, and
 * the generic list only ever hands them back to the hooks that produced the
 * rows of that same entity.
 */
export function defineListOverride<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow = TData,
>(override: EntityListOverride<TData, TFilters, TRow>): AnyEntityListOverride {
  // SAFETY: the generic list resolves this module by the same entity key that
  // produced its rows, so the narrower row types only ever meet their own rows.
  // The module's callbacks are contravariant in that row, so no single
  // assertion reaches the registry's base-row view.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the one heterogeneous-registry widening; see SAFETY above
  return override as unknown as AnyEntityListOverride;
}

export type ListOverrideRegistry = Partial<
  Record<BrowserRoutedEntity, AnyEntityListOverride>
>;

/**
 * Column interleaving for `compose`: place declared columns by id among the
 * hand-added ones, then flush whatever the module did not place (a declared
 * column is never silently dropped).
 */
export type ColumnAdder<TData extends BaseListRow> = Parameters<
  Parameters<typeof createCubbyColumnCollection<TData>>[0]
>[0];

export function interleaveDeclared<TData extends BaseListRow>(
  declared: CubbyColumnCollection<TData>,
  add: ColumnAdder<TData>,
) {
  const placed = new Set<string>();
  return {
    place: (id: string) => {
      placed.add(id);
      declared.filter((column) => column.id === id).visit(add);
    },
    rest: () => {
      declared.filter((column) => !placed.has(String(column.id))).visit(add);
    },
  };
}

function columnId<TData extends BaseListRow, TValue extends CellData>(
  column: CubbyColumnDef<TData, TValue>,
): string | null {
  if (column.id !== undefined) return String(column.id);
  return "accessorKey" in column ? String(column.accessorKey) : null;
}

/**
 * Every hand-composed list column must explicitly declare provenance or opt
 * out with `provenance: null`. Declared fields are compiler-audited instead.
 * This turns a newly added specialist projection into a loud local failure
 * rather than an unlabeled source that slips into one route.
 */
export function assertSpecialistColumnProvenance<TData extends BaseListRow>(
  entity: BrowserRoutedEntity,
  declared: CubbyColumnCollection<TData>,
  composed: CubbyColumnCollection<TData>,
): CubbyColumnCollection<TData> {
  const declaredIds = new Set<string>();
  declared.visit((column) => {
    const id = columnId(column);
    if (id !== null) declaredIds.add(id);
  });
  composed.visit((column) => {
    const id = columnId(column);
    if (id === null || declaredIds.has(id)) return;
    if (column.meta?.provenance === undefined) {
      throw new Error(
        `${entity}.${id} is a specialist list column without explicit provenance`,
      );
    }
  });
  return composed;
}
