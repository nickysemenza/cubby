import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { Spinner } from "~/components/ui/spinner";
import { entityPreviewQueryOptions } from "~/entities/entity-query";

import { EntityInlineLink } from "./EntityInlineLink";

// Entity types this inline link resolves to a name via the detail transport. Inventory &
// cookbook are intentionally excluded — they render as plain links below.
const INLINE_LINK_FETCHABLE = [
  "product",
  "location",
  "recipe",
  "ingredient",
] as const satisfies readonly Entity[];
type FetchableInlineEntity = (typeof INLINE_LINK_FETCHABLE)[number];

const isFetchableInlineEntity = (
  entity: AuditEntityType,
): entity is FetchableInlineEntity =>
  INLINE_LINK_FETCHABLE.some((candidate) => candidate === entity);

interface EntityInlineLinkByIdProps {
  entityType: AuditEntityType;
  entityId: string;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
}

/**
 * A "smart" inline link that fetches entity data by ID and renders the appropriate link.
 * Uses React Query caching so multiple links with the same ID won't cause duplicate fetches.
 */
export function EntityInlineLinkById({
  entityType,
  entityId,
  compact,
}: EntityInlineLinkByIdProps) {
  // Resolve the name via the shared entity-detail mapping for the fetchable
  // inline-link types; everything else (inventory, cookbook, or an out-of-union runtime
  // entityType from a legacy audit row) gets a skipped query so useQuery never
  // receives a non-object arg — v5 throws "only the Object form is allowed".
  const queryOptions = useMemo(
    () =>
      isFetchableInlineEntity(entityType)
        ? entityPreviewQueryOptions(entityType, entityId)
        : { queryKey: ["invalid"] as const, queryFn: skipToken },
    [entityType, entityId],
  );

  // Single query hook instead of 4 disabled ones
  // SAFETY: the options union is narrowed by the fetchable entity guard, but
  // React Query's generic overload cannot express that correlation.
  const query = useQuery(queryOptions as never);

  // Inventory entries have no getByID that returns product info, so there is
  // no name to resolve here — and this component is handed a uuid, not the
  // public shortcode a URL needs. Render unlinked rather than build a uuid URL;
  // callers that can supply a shortcode should use `EntityInlineLink`.
  if (entityType === "inventory") {
    return <span className="text-sm font-medium">Inventory Entry</span>;
  }

  // Cookbooks are browsed by name, not id, and have no getByID — link to the
  // cookbook index rather than resolving the id to a name here.
  if (entityType === "cookbook") {
    return (
      <a href="/cookbooks" className="text-sm font-medium hover:underline">
        Cookbook
      </a>
    );
  }

  if (isFetchableInlineEntity(entityType) && query.isLoading) {
    return <Spinner className="text-muted-foreground" />;
  }

  if (isFetchableInlineEntity(entityType) && query.data) {
    // SAFETY: entityPreviewQueryOptions selects a generated detail operation
    // whose fetchable-entity outputs all carry canonical displayImages.
    const data = query.data as { displayImages: ImageUrlSummary[] };
    return (
      <EntityInlineLink
        displayImage={data.displayImages[0] ?? null}
        entity={entityType}
        // SAFETY: the preview query options and this discriminant are selected
        // by the same fetchable entity guard above.
        data={data as never}
        compact={compact}
      />
    );
  }

  // A fetchable type with no data → the entity was deleted. Any other type
  // (an audit row carrying an entityType outside our union) → just label it.
  return (
    <span className="text-sm text-muted-foreground italic">
      {entityType}
      {isFetchableInlineEntity(entityType) ? " (deleted)" : ""}
    </span>
  );
}
