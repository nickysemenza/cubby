import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { entities } from "~/entities/entities";
import type { SearchableEntity } from "~/schemas/search";
import { useTRPC } from "~/trpc/react";
import { IngredientDetail } from "../ingredients/ingredient-detail";
import { InventoryDetail } from "../inventory/inventory-detail";
import { LocationDetail } from "../locations/location-detail";
import { ProductDetail } from "../products/product-detail";
import RecipeDetail from "../recipe/RecipeDetail";

interface EntityPreviewPanelProps {
  entityType: SearchableEntity;
  id: string;
}

export function EntityPreviewPanel({
  entityType,
  id,
}: EntityPreviewPanelProps) {
  const api = useTRPC();

  // All queries - only the one matching entityType will be enabled
  const queries = {
    product: useQuery({
      ...api.product.getByID.queryOptions({ id }),
      enabled: entityType === "product",
    }),
    recipe: useQuery({
      ...api.recipe.getByID.queryOptions({ id }),
      enabled: entityType === "recipe",
    }),
    ingredient: useQuery({
      ...api.ingredient.getByID.queryOptions({ id }),
      enabled: entityType === "ingredient",
    }),
    location: useQuery({
      ...api.location.getByID.queryOptions({ id }),
      enabled: entityType === "location",
    }),
    "inventory-item": useQuery({
      ...api.inventoryItem.getById.queryOptions({ id }),
      enabled: entityType === "inventory-item",
    }),
  };

  const activeQuery = queries[entityType];
  const { isLoading, error } = activeQuery;

  // Get entity definition for link
  const entityDef = entities[entityType];
  const detailPath = `/${entityDef.basePath}/${id}`;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
          <Button variant="outline" size="sm" asChild>
            <Link
              to={detailPath as "/products/$id"}
              params={{ id }}
              className="inline-flex items-center"
            >
              <ExternalLink className="mr-1 h-3 w-3" />
              View Full Details
            </Link>
          </Button>
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto p-6">
        {entityType === "product" && queries.product.data && (
          <ProductDetail product={queries.product.data} />
        )}
        {entityType === "recipe" && queries.recipe.data && (
          <RecipeDetail recipe={queries.recipe.data} />
        )}
        {entityType === "ingredient" && queries.ingredient.data && (
          <IngredientDetail ingredient={queries.ingredient.data} />
        )}
        {entityType === "location" && queries.location.data && (
          <LocationDetail location={queries.location.data} />
        )}
        {entityType === "inventory-item" && queries["inventory-item"].data && (
          <InventoryDetail inventoryItem={queries["inventory-item"].data} />
        )}
      </div>
    </div>
  );
}
