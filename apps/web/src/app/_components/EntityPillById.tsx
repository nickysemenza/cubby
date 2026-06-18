import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Spinner } from "~/components/ui/spinner";
import { entityQueryOptions } from "~/entities/entity-query";
import { useTRPC } from "~/trpc/react";
import { EntityPillLink } from "./EntityPill";

// Entity types this pill resolves to a name via getByID. Inventory & cookbook
// are intentionally excluded — they render as plain links below, not fetched.
const PILL_FETCHABLE = [
  "product",
  "location",
  "recipe",
  "ingredient",
] as const satisfies readonly Entity[];

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

  // Resolve the name via the shared entity→getByID mapping for the fetchable
  // pill types; everything else (inventory, cookbook, or an out-of-union runtime
  // entityType from a legacy audit row) gets a skipped query so useQuery never
  // receives a non-object arg — v5 throws "only the Object form is allowed".
  const isFetchable = (PILL_FETCHABLE as readonly string[]).includes(
    entityType,
  );
  const queryOptions = useMemo(
    () =>
      isFetchable
        ? entityQueryOptions(trpc, entityType as Entity, entityId)
        : { queryKey: ["invalid"] as const, queryFn: skipToken },
    [isFetchable, entityType, entityId, trpc],
  );

  // Single query hook instead of 4 disabled ones
  // biome-ignore lint/suspicious/noExplicitAny: useQuery can't narrow the union of getByID queryOptions
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
