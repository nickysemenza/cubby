import type { AuditEntityType } from "@cubby/schemas/audit";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Spinner } from "~/components/ui/spinner";
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
      case "cookbook":
        // No getByID for these — rendered via an early return below. Return a
        // valid (skipped) query so useQuery never receives undefined (v5 throws).
        return { queryKey: ["invalid"] as const, queryFn: skipToken };
      case "product":
        return trpc.product.getByID.queryOptions({ id: entityId });
      case "location":
        return trpc.location.getByID.queryOptions({ id: entityId });
      case "recipe":
        return trpc.recipe.getByID.queryOptions({ id: entityId });
      case "ingredient":
        return trpc.ingredient.getByID.queryOptions({ id: entityId });
      default:
        // AuditEntityType is the six cases above, but audit rows can carry a
        // runtime entityType outside that union (legacy/other-domain entries).
        // Return a valid (skipped) query so useQuery never receives undefined
        // — v5 throws "only the Object form is allowed" on a non-object arg.
        return { queryKey: ["invalid"] as const, queryFn: skipToken };
    }
  }, [entityType, entityId, trpc]);

  // Single query hook instead of 4 disabled ones
  // biome-ignore lint/suspicious/noExplicitAny: TypeScript can't narrow discriminated union in switch statement
  const query = useQuery(queryOptions as any);

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

  // Cookbooks are browsed by name, not id, and have no getByID — link to the
  // cookbook index rather than resolving the id to a name here.
  if (entityType === "cookbook") {
    return (
      <a href="/cookbooks" className="font-medium text-sm hover:underline">
        Cookbook
      </a>
    );
  }

  const isFetchable =
    entityType === "product" ||
    entityType === "location" ||
    entityType === "recipe" ||
    entityType === "ingredient";

  if (isFetchable && query.isLoading) {
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

  // A fetchable type with no data → the entity was deleted. Any other type
  // (an audit row carrying an entityType outside our union) → just label it.
  return (
    <span className="text-muted-foreground text-sm italic">
      {entityType}
      {isFetchable ? " (deleted)" : ""}
    </span>
  );
}
