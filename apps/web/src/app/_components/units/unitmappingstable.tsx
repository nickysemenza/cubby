import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import RTable from "../data-table/Table";
import { EntityPillLink } from "../EntityPill";

// Component for lazy loading food data and rendering FoodPillLink
const LazyFoodPillLink: React.FC<{ fdcId: number }> = ({ fdcId }) => {
  const api = useTRPC();
  const { data: food, isLoading } = useQuery(
    api.usda.getByID.queryOptions(
      { id: fdcId },
      {
        // Cache for 5 minutes since food data doesn't change often
        staleTime: 5 * 60 * 1000,
      },
    ),
  );

  // Show placeholder while loading or if no data
  const displayFood = food || {
    fdc_id: fdcId,
    foodInfo: { description: `food ${fdcId}${isLoading ? "..." : ""}` },
  };

  return <EntityPillLink entity="usda-food" data={displayFood} compact />;
};

// Component for lazy loading product data and rendering ProductPillLink
const LazyProductPillLink: React.FC<{ productId: string }> = ({
  productId,
}) => {
  const api = useTRPC();
  const { data: product, isLoading } = useQuery(
    api.product.getByID.queryOptions(
      { id: productId },
      {
        // Cache for 5 minutes since product data doesn't change often
        staleTime: 5 * 60 * 1000,
      },
    ),
  );

  // Show placeholder while loading or if no data
  const displayProduct = product || {
    id: productId,
    name: `product ${productId.slice(0, 8)}${isLoading ? "..." : ""}`,
    manufacturer: "",
  };

  return <EntityPillLink entity="product" data={displayProduct} compact />;
};

export const UnitMappingsTable: React.FC<{
  mappings: UnitMapping[];
}> = ({ mappings }) => {
  const columnHelper = createColumnHelper<UnitMapping>();

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => wasm.format_amount(row.a), {
        id: "from",
        header: "From",
        enableSorting: false,
        meta: { className: "p-0.5" },
      }),
      columnHelper.accessor((row) => wasm.format_amount(row.b), {
        id: "to",
        header: "To",
        enableSorting: false,
        meta: { className: "p-0.5" },
      }),
      columnHelper.accessor("source", {
        id: "source",
        header: "Source",
        enableSorting: false,
        meta: { className: "truncate p-0.5" },
        cell: (info) => {
          const mapping = info.row.original;
          const { source, sourceMetadata } = mapping;

          if (!sourceMetadata) {
            return source || "";
          }

          return (
            <div className="flex items-center gap-1">
              <span>{source || ""}</span>
              {sourceMetadata.type === "food" && (
                <LazyFoodPillLink fdcId={sourceMetadata.fdcId} />
              )}
              {sourceMetadata.type === "product" && (
                <LazyProductPillLink productId={sourceMetadata.productId} />
              )}
            </div>
          );
        },
      }),
    ],
    [columnHelper],
  );

  const table = useReactTable({
    data: mappings,
    columns,
    enableSorting: false,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row, i) => `${i}-${row.source}`,
  });

  return <RTable table={table} />;
};
