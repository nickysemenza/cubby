import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
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

  // All queries - only the one matching entityType will be enabled
  const productQuery = useQuery({
    ...api.product.getByID.queryOptions({ id }),
    enabled: entityType === "product",
  });
  const recipeQuery = useQuery({
    ...api.recipe.getByID.queryOptions({ id }),
    enabled: entityType === "recipe",
  });
  const ingredientQuery = useQuery({
    ...api.ingredient.getByID.queryOptions({ id }),
    enabled: entityType === "ingredient",
  });
  const locationQuery = useQuery({
    ...api.location.getByID.queryOptions({ id }),
    enabled: entityType === "location",
  });
  const inventoryQuery = useQuery({
    ...api.inventoryItem.getByID.queryOptions({ id }),
    enabled: entityType === "inventory-item",
  });
  const usdaQuery = useQuery({
    ...api.usda.getByID.queryOptions({ id: parseInt(id, 10) }),
    enabled: entityType === "usda-food",
  });
  const imageQuery = useQuery({
    ...api.image.getImageById.queryOptions({ id }),
    enabled: entityType === "image",
  });

  // Get active query based on entity type
  const getActiveQuery = () => {
    switch (entityType) {
      case "product":
        return productQuery;
      case "recipe":
        return recipeQuery;
      case "ingredient":
        return ingredientQuery;
      case "location":
        return locationQuery;
      case "inventory-item":
        return inventoryQuery;
      case "usda-food":
        return usdaQuery;
      case "image":
        return imageQuery;
    }
  };

  const activeQuery = getActiveQuery();
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
        {entityType === "product" && productQuery.data && (
          <ProductDetail product={productQuery.data} />
        )}
        {entityType === "recipe" && recipeQuery.data && (
          <RecipeDetail recipe={recipeQuery.data} />
        )}
        {entityType === "ingredient" && ingredientQuery.data && (
          <IngredientDetail ingredient={ingredientQuery.data} />
        )}
        {entityType === "location" && locationQuery.data && (
          <LocationDetail location={locationQuery.data} />
        )}
        {entityType === "inventory-item" && inventoryQuery.data && (
          <InventoryDetail inventoryitem={inventoryQuery.data} />
        )}
        {entityType === "usda-food" && usdaQuery.data && (
          <USDAFoodDetail id={parseInt(id, 10)} food={usdaQuery.data} />
        )}
        {entityType === "image" && imageQuery.data && (
          <ImageDetail image={imageQuery.data} />
        )}
      </div>
    </div>
  );
}
