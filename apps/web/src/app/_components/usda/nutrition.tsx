import type { NutrientSummary, NutritionInfo } from "@cubby/usda-schemas";
import { useMemo } from "react";

import RTable from "../data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "../data-table/table-features";
import { useCubbyTableLayout } from "../data-table/table-layout";

export const NutritionInfoTable: React.FC<{
  n: NutritionInfo;
}> = ({ n }) => {
  const { nutrientSummary } = n;
  const columnHelper = createCubbyColumnHelper<NutrientSummary>();

  const columns = useMemo<CubbyColumnDef<NutrientSummary>[]>(
    () => [
      columnHelper.accessor("name", {
        header: "Nutrient",
        enableSorting: false,
        size: 200,
        minSize: 100,
        maxSize: 300,
        meta: { className: "min-w-[100px] max-w-[200px] truncate" },
      }),
      columnHelper.accessor("amount", {
        header: "Amount",
        enableSorting: false,
        size: 96,
        minSize: 60,
        meta: { className: "min-w-[60px] text-right" },
      }),
      columnHelper.accessor("unit", {
        header: "Unit",
        enableSorting: false,
        size: 64,
        minSize: 40,
        meta: { className: "min-w-[40px]" },
      }),
    ],
    [columnHelper],
  );

  const layout = useCubbyTableLayout({
    key: "usda:nutrition",
    columns,
  });
  const table = useCubbyTable({
    data: nutrientSummary,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    enableSorting: false,
    enableFilters: false,
    getRowId: (row) => `${row.name}-${row.unit}`,
    initialState: {
      pagination: {
        pageSize: 10,
        pageIndex: 0,
      },
    },
  });

  if (nutrientSummary.length === 0) {
    return null;
  }

  return (
    <div className="text-xs">
      <RTable table={table} embedded />
    </div>
  );
};
