import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { AuditEntityType } from "~/server/repo/audit-log";
import { useTRPC } from "~/trpc/react";
import { EntityPillLink } from "./EntityPill";

interface EntityPillByIdProps {
  entityType: AuditEntityType;
  entityId: string;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
}

/**
 * A "smart" pill component that fetches entity data by ID and renders the appropriate pill.
 * Uses React Query caching so multiple pills with the same ID won't cause duplicate fetches.
 */
export function EntityPillById({
  entityType,
  entityId,
  compact,
}: EntityPillByIdProps) {
  const trpc = useTRPC();

  // All queries must be called unconditionally (React hooks rules)
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

  // Inventory entries don't have a getByID that returns product info
  if (entityType === "inventory") {
    return (
      <a
        href={`/inventory/${entityId}`}
        className="font-medium text-sm hover:underline"
      >
        Inventory Entry
      </a>
    );
  }

  // Lookup pattern for loading and data
  const queries = {
    product: productQuery,
    location: locationQuery,
    recipe: recipeQuery,
    ingredient: ingredientQuery,
  } as const;

  const query = queries[entityType as keyof typeof queries];
  if (query?.isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  if (query?.data) {
    return (
      <EntityPillLink
        entity={entityType as "product" | "location" | "recipe" | "ingredient"}
        data={query.data as never}
        compact={compact}
      />
    );
  }

  // Fallback for errors or missing data (entity might have been deleted)
  return (
    <span className="text-muted-foreground text-sm italic">
      {entityType} (deleted)
    </span>
  );
}
