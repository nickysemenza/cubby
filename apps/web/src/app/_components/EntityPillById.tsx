import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Spinner } from "~/components/ui/spinner";
import type { AuditEntityType } from "~/schemas/audit";
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

  // Get query options based on entity type (stable reference with useMemo)
  const queryOptions = useMemo(() => {
    switch (entityType) {
      case "inventory":
        // Inventory entries don't have a getByID that returns product info
        return { queryKey: ["invalid"], enabled: false };
      case "product":
        return trpc.product.getByID.queryOptions({ id: entityId });
      case "location":
        return trpc.location.getByID.queryOptions({ id: entityId });
      case "recipe":
        return trpc.recipe.getByID.queryOptions({ id: entityId });
      case "ingredient":
        return trpc.ingredient.getByID.queryOptions({ id: entityId });
    }
  }, [entityType, entityId, trpc]);

  // Single query hook instead of 4 disabled ones
  const query = useQuery(queryOptions);

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

  if (query.isLoading) {
    return <Spinner className="text-muted-foreground" />;
  }

  if (query.data) {
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
