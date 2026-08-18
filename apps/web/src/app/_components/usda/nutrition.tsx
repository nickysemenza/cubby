import type { NutrientSummary, NutritionInfo } from "@cubby/usda-schemas";
import { useTable } from "@tanstack/react-table";
import { useMemo } from "react";
import RTable from "../data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  cubbyTableFeatures,
} from "../data-table/table-features";

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
        meta: { className: "min-w-[100px] max-w-[200px] truncate" },
      }),
      columnHelper.accessor("amount", {
        header: "Amount",
        enableSorting: false,
        meta: { className: "min-w-[60px] text-right" },
      }),
      columnHelper.accessor("unit", {
        header: "Unit",
        enableSorting: false,
        meta: { className: "min-w-[40px]" },
      }),
    ],
    [columnHelper],
  );

  const table = useTable<typeof cubbyTableFeatures, NutrientSummary>({
    features: cubbyTableFeatures,
    data: nutrientSummary,
    columns,
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
      <RTable table={table} sizingKey="usda:nutrition" embedded />
    </div>
  );
};
