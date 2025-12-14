import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { UnitMapping } from "~/schemas/unitmapping";

import { wasm } from "~/lib/wasm";
import { NoneState } from "../NoneState";
import { FoodPillLink, ProductPillLink } from "../EntityPill";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";

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

  return <FoodPillLink food={displayFood} />;
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

  return <ProductPillLink product={displayProduct} />;
};

// Helper function to render source with metadata-based links
const renderSourceWithMetadata = (mapping: UnitMapping) => {
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
};

export const UnitMappingsTable: React.FC<{
  mappings: UnitMapping[];
}> = ({ mappings }) => {
  return (
    <Table className="table-auto text-xs">
      <TableHeader>
        <TableRow>
          <TableHead className="p-0.5">From</TableHead>
          <TableHead className="p-0.5">To</TableHead>
          <TableHead className="p-0.5">Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mappings.length === 0 && (
          <TableRow>
            <TableCell colSpan={3} className="p-0.5 text-center">
              <NoneState />
            </TableCell>
          </TableRow>
        )}
        {mappings.map((unitMapping, x) => {
          return (
            <TableRow key={`${x}-${unitMapping.source}`}>
              <TableCell className="p-0.5">
                {wasm.format_amount(unitMapping.a)}
              </TableCell>
              <TableCell className="p-0.5">
                {wasm.format_amount(unitMapping.b)}
              </TableCell>
              <TableCell className="truncate p-0.5">
                {renderSourceWithMetadata(unitMapping)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};
