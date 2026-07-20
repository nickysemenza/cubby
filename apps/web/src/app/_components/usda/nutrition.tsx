import type { NutrientSummary, NutritionInfo } from "@cubby/usda-schemas";
import {
  createColumnHelper,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import RTable from "../data-table/Table";

export const NutritionInfoTable: React.FC<{
  n: NutritionInfo;
}> = ({ n }) => {
  const { nutrientSummary } = n;
  const columnHelper = createColumnHelper<NutrientSummary>();

  const columns = useMemo(
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

  const table = useReactTable({
    data: nutrientSummary,
    columns,
    enableSorting: false,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
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
