import type { Entity } from "@cubby/schemas/entity";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { Button } from "~/components/ui/button";
import { SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { entities } from "~/entities/entities";
import { entityQueryOptions, fdcIdFromParam } from "~/entities/entity-query";
import { useTRPC } from "~/trpc/react";
import { ImageDetail } from "../images/image-detail";
import { IngredientDetail } from "../ingredients/ingredient-detail";
import { InventoryDetail } from "../inventory/inventory-detail";
import { LocationDetail } from "../locations/location-detail";
import { ProductDetail } from "../products/product-detail";
import RecipeDetail from "../recipe/RecipeDetail";
import { USDAFoodDetail } from "../usda/USDAFoodDetail";

interface EntityPreviewPanelProps {
  entityType: Entity;
  id: string;
}

export function EntityPreviewPanel({
  entityType,
  id,
}: EntityPreviewPanelProps) {
  const api = useTRPC();

  // One shared entity→getByID mapping (entity-query), stable for useQuery.
  const queryOptions = useMemo(
    () => entityQueryOptions(api, entityType, id),
    [entityType, id, api],
  );

  // Single query hook instead of 7 disabled ones
  // biome-ignore lint/suspicious/noExplicitAny: useQuery can't narrow the union of getByID queryOptions
  const query = useQuery(queryOptions as any);
  const { isLoading, error, data } = query;

  // Get entity definition for link
  const entityDef = entities[entityType];

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="md" className="text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Failed to load {entityDef.label.toLowerCase()}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b pr-12 pb-4">
        <div className="flex items-center justify-between">
          <SheetTitle>Preview</SheetTitle>
          <Button
            variant="outline"
            size="sm"
            render={<Link to={entityDef.routes.detail} params={{ id }} />}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            View Full Details
          </Button>
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto p-6">
        {entityType === "product" ? (
          data ? (
            <ProductDetail product={data as never} />
          ) : null
        ) : null}
        {entityType === "recipe" ? (
          data ? (
            <RecipeDetail recipe={data as never} />
          ) : null
        ) : null}
        {entityType === "ingredient" ? (
          data ? (
            <IngredientDetail ingredient={data as never} />
          ) : null
        ) : null}
        {entityType === "location" ? (
          data ? (
            <LocationDetail location={data as never} />
          ) : null
        ) : null}
        {entityType === "inventory" ? (
          data ? (
            <InventoryDetail inventoryitem={data as never} />
          ) : null
        ) : null}
        {entityType === "usda-food" ? (
          data ? (
            <USDAFoodDetail id={fdcIdFromParam(id)} food={data as never} />
          ) : null
        ) : null}
        {entityType === "image" ? (
          data ? (
            <ImageDetail image={data as never} />
          ) : null
        ) : null}
      </div>
    </div>
  );
}
