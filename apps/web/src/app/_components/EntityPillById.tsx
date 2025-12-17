"use client";

import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import {
  ProductPillLink,
  LocationPillLink,
  RecipePillLink,
  IngredientPillLink,
} from "./EntityPill";
import { Loader2 } from "lucide-react";
import { type AuditEntityType } from "~/server/repo/audit-log";

interface EntityPillByIdProps {
  entityType: AuditEntityType;
  entityId: string;
}

/**
 * A "smart" pill component that fetches entity data by ID and renders the appropriate pill.
 * Uses React Query caching so multiple pills with the same ID won't cause duplicate fetches.
 */
export function EntityPillById({ entityType, entityId }: EntityPillByIdProps) {
  const trpc = useTRPC();

  // Select the appropriate query based on entity type
  const productQuery = useQuery({
    ...trpc.product.getByID.queryOptions({ id: entityId }),
    enabled: entityType === "product",
  });

  const locationQuery = useQuery({
    ...trpc.location.getByID.queryOptions({ id: entityId }),
    enabled: entityType === "location",
  });

  const recipeQuery = useQuery({
    ...trpc.recipe.getByID.queryOptions({ id: entityId }),
    enabled: entityType === "recipe",
  });

  const ingredientQuery = useQuery({
    ...trpc.ingredient.getByID.queryOptions({ id: entityId }),
    enabled: entityType === "ingredient",
  });

  // Inventory entries don't have a direct getByID that returns product info,
  // so we'll just show a simple link for now
  if (entityType === "inventory") {
    return (
      <a
        href={`/inventory/${entityId}`}
        className="text-sm font-medium hover:underline"
      >
        Inventory Entry
      </a>
    );
  }

  // Loading state
  const isLoading =
    (entityType === "product" && productQuery.isLoading) ||
    (entityType === "location" && locationQuery.isLoading) ||
    (entityType === "recipe" && recipeQuery.isLoading) ||
    (entityType === "ingredient" && ingredientQuery.isLoading);

  if (isLoading) {
    return <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />;
  }

  // Render the appropriate pill based on entity type
  switch (entityType) {
    case "product":
      if (productQuery.data) {
        return <ProductPillLink product={productQuery.data} />;
      }
      break;
    case "location":
      if (locationQuery.data) {
        return <LocationPillLink location={locationQuery.data} />;
      }
      break;
    case "recipe":
      if (recipeQuery.data) {
        return <RecipePillLink recipe={recipeQuery.data} />;
      }
      break;
    case "ingredient":
      if (ingredientQuery.data) {
        return (
          <IngredientPillLink
            name={ingredientQuery.data.name}
            id={ingredientQuery.data.id}
          />
        );
      }
      break;
  }

  // Fallback for errors or missing data (entity might have been deleted)
  return (
    <span className="text-muted-foreground text-sm italic">
      {entityType} (deleted)
    </span>
  );
}
