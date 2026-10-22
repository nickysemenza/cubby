import type {
  ColumnFiltersState,
  ColumnVisibilityState,
  OnChangeFn,
  RowData,
} from "@tanstack/react-table";
import { useMemo } from "react";

import { useTableColumnLayout } from "./column-layout";
import {
  type CubbyColumnCollection,
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "./table-features";

/** A bounded list: client filtering/sorting, shared layout, no URL ownership. */
export function useLocalTable<T extends RowData>({
  rows,
  columns,
  getRowId,
  search,
  columnFilters,
  onColumnFiltersChange,
  rowContentVersion,
  totalCount = rows.length,
}: {
  rows: readonly T[];
  columns: CubbyColumnCollection<T>;
  getRowId: (row: T) => string;
  search?: { text: (row: T) => string; placeholder: string };
  columnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  rowContentVersion?: unknown;
  /** A larger source total suppresses local counts that could imply full coverage. */
  totalCount?: number;
}) {
  const data = useMemo(() => [...rows], [rows]);
  const searchableColumns = useMemo(() => {
    if (!search) return columns;
    const helper = createCubbyColumnHelper<T>();
    return createCubbyColumnCollection<T>((add) => {
      columns.visit(add);
      // Search spans the row, rather than pretending one displayed field owns it.
      // Keep its accessor out of both the grid and the column-visibility menu.
      add(
        helper.accessor(search.text, {
          id: "_search",
          header: "Search",
          enableSorting: false,
          enableHiding: false,
          filterFn: "includesString",
        }),
      );
    });
  }, [columns, search]);
  const initialColumnVisibility = useMemo(() => {
    const visibility: ColumnVisibilityState = {};
    if (search) visibility._search = false;
    return visibility;
  }, [search]);
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns: searchableColumns,
    initialColumnVisibility,
  });
  const primarySearch = useMemo(
    () =>
      search ? { key: "_search", placeholder: search.placeholder } : undefined,
    [search],
  );
  return useCubbyTable({
    data,
    columns: tableColumns,
    getRowId,
    enableRowSelection: false,
    meta: {
      defaultLayout,
      primarySearch,
      rowContentVersion,
      completeLocalData: totalCount === rows.length,
    },
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    ...(columnFilters ? { state: { columnFilters } } : {}),
    ...(onColumnFiltersChange ? { onColumnFiltersChange } : {}),
  });
}
