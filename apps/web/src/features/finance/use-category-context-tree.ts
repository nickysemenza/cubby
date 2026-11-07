import { useEffect, useMemo, useRef } from "react";

import type {
  BaseListRow,
  EntityListTreeConfig,
  UseEntityListReturn,
} from "~/entity/hooks/use-entity-list";

export type CategoryContextRow<T> = T & {
  subRows?: CategoryContextRow<T>[];
  categoryContext?: boolean;
};

/** Matching rows keep their filter membership; ancestors are excluded from selection. */
export function useCategoryContextTree<
  T extends BaseListRow & { parentId?: string | null },
>(catalog: readonly T[], nested: boolean) {
  const tree = useMemo(():
    | EntityListTreeConfig<CategoryContextRow<T>, T>
    | undefined => {
    if (!nested) return undefined;
    const byId = new Map<string, T>(catalog.map((row) => [row.id, row]));
    return {
      expandable: true,
      rowIsEntity: (row) => !row.categoryContext,
      getSubRows: (row) => row.subRows,
      nest: (matches) => {
        const matching = new Set(matches.map((row) => row.id));
        const originals = new Map(byId);
        for (const row of matches) originals.set(row.id, row);
        const nodes = new Map<string, CategoryContextRow<T>>();
        // Server order owns matching siblings. A context ancestor follows its
        // first matching descendant, rather than a second unfiltered sort.
        const rank = new Map(matches.map((row, index) => [row.id, index]));
        for (const [index, match] of matches.entries()) {
          const visited = new Set<string>();
          let row: T | undefined = match;
          while (row && !visited.has(row.id)) {
            visited.add(row.id);
            if (!rank.has(row.id)) rank.set(row.id, index);
            if (!nodes.has(row.id))
              nodes.set(row.id, {
                ...row,
                categoryContext: !matching.has(row.id),
                subRows: [],
              });
            row = row.parentId ? originals.get(row.parentId) : undefined;
          }
        }
        const roots: CategoryContextRow<T>[] = [];
        for (const node of nodes.values()) {
          const parent = node.parentId ? nodes.get(node.parentId) : undefined;
          if (parent && parent !== node) parent.subRows?.push(node);
          else roots.push(node);
        }
        const order = (rows: CategoryContextRow<T>[]) => {
          rows.sort(
            (left, right) =>
              (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
              (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
          );
          for (const row of rows) if (row.subRows?.length) order(row.subRows);
        };
        order(roots);
        return roots;
      },
    };
  }, [catalog, nested]);

  function useWorkbench(
    list: UseEntityListReturn<CategoryContextRow<T>, object, T>,
  ) {
    return useCategoryWorkbench(list, nested);
  }
  return { tree, useWorkbench };
}

function useCategoryWorkbench<
  T extends BaseListRow & { parentId?: string | null },
>(
  list: UseEntityListReturn<CategoryContextRow<T>, object, T>,
  nested: boolean,
) {
  const controls = list.workbench.infiniteScroll;
  const table = list.workbench.table;
  const rows = table.getCoreRowModel().flatRows;
  const scope = JSON.stringify([list.currentFilters, table.state.sorting]);
  const hasFilters = table.state.columnFilters.length > 0;
  const priorScope = useRef<string | null>(null);
  const opened = useRef(new Set<string>());
  useEffect(() => {
    if (
      nested &&
      controls.hasNextPage &&
      !controls.isFetchingNextPage &&
      !list.workbench.error
    )
      controls.fetchNextPage();
  }, [nested, controls, list.workbench.error]);
  useEffect(() => {
    if (!nested) return;
    if (priorScope.current !== scope) {
      priorScope.current = scope;
      opened.current.clear();
      table.setExpanded({});
    }
    if (!hasFilters) return;
    const additions = rows.filter(
      (row) => row.subRows.length > 0 && !opened.current.has(row.id),
    );
    if (!additions.length) return;
    for (const row of additions) opened.current.add(row.id);
    table.setExpanded((current) =>
      current === true
        ? current
        : {
            ...current,
            ...Object.fromEntries(additions.map((row) => [row.id, true])),
          },
    );
  }, [nested, scope, hasFilters, rows, table]);
  return {
    renderMobileRowFooter: (row: CategoryContextRow<T>) =>
      row.categoryContext ? "Ancestor" : null,
    getRowClassName: (row: { original: CategoryContextRow<T> }) =>
      row.original.categoryContext ? "text-muted-foreground" : undefined,
  };
}
