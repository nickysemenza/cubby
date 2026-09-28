import type { AuditEntityKind } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  imageUrlSummary,
  type ImageUrlSummary,
} from "@cubby/schemas/image-summary";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";

import { Spinner } from "~/components/ui/spinner";
import {
  isGeneratedBrowserCrudEntity,
  type StandardEntity,
} from "~/entities/entity-contracts";
import { entityPreviewQueryOptions } from "~/entities/entity-query";

import { EntityInlineLink } from "./EntityInlineLink";
import { EntityReferenceLink } from "./EntityReferenceLink";

const isNamedEntity = (
  entity: AuditEntityKind,
): entity is StandardEntity & AuditEntityKind =>
  entity !== "inventory" &&
  entity !== "cookbook" &&
  isGeneratedBrowserCrudEntity(entity);

const namedRecordSchema = z.looseObject({
  displayImages: z.array(imageUrlSummary).optional().catch(undefined),
});

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
  entity: AuditEntityKind,
): entity is FetchableInlineEntity =>
  INLINE_LINK_FETCHABLE.some((candidate) => candidate === entity);

interface EntityInlineLinkByIdProps {
  entityKind: AuditEntityKind;
  entityId: string;
  name?: string | null;
  /** Compact mode: truncates long names with max-width */
  compact?: boolean;
}

/**
 * A "smart" inline link that fetches entity data by ID and renders the appropriate link.
 * Uses React Query caching so multiple links with the same ID won't cause duplicate fetches.
 */
export function EntityInlineLinkById({
  entityKind,
  entityId,
  name,
  compact,
}: EntityInlineLinkByIdProps) {
  // Resolve the name via the shared entity-detail mapping for every named
  // entity; everything else (inventory, cookbook, or an out-of-union runtime
  // entityKind from a legacy audit row) gets a skipped query so useQuery never
  // receives a non-object arg — v5 throws "only the Object form is allowed".
  const queryOptions = useMemo(
    () =>
      isNamedEntity(entityKind) && !name
        ? entityPreviewQueryOptions(entityKind, entityId)
        : { queryKey: ["invalid"] as const, queryFn: skipToken },
    [entityKind, entityId, name],
  );

  // SAFETY: the options union is narrowed by the named entity guard, but
  // React Query's generic overload cannot express that correlation.
  const query = useQuery(queryOptions as never);

  // Inventory entries have no getByID that returns product info, so there is
  // no name to resolve here — and this component is handed a uuid, not the
  // public shortcode a URL needs. Render unlinked rather than build a uuid URL;
  // callers that can supply a shortcode should use `EntityInlineLink`.
  if (entityKind === "inventory") {
    return <span className="text-sm font-medium">Inventory Entry</span>;
  }

  // Cookbooks are browsed by name, not id, and have no getByID — link to the
  // cookbook index rather than resolving the id to a name here.
  if (entityKind === "cookbook") {
    return (
      <a href="/cookbooks" className="text-sm font-medium hover:underline">
        Cookbook
      </a>
    );
  }

  if (name && isNamedEntity(entityKind)) {
    return (
      <EntityReferenceLink entity={entityKind} id={entityId} name={name} />
    );
  }

  if (!isFetchableInlineEntity(entityKind) && isNamedEntity(entityKind)) {
    // Every other generated entity names itself through its manifest
    // `titleField`; a bare shortcode link (`PRJ-4UMD`) says nothing to a reader.
    const record = namedRecordSchema.safeParse(query.data);
    return (
      <EntityReferenceLink
        entity={entityKind}
        id={entityId}
        name={
          record.success
            ? z
                .string()
                .catch("")
                .parse(record.data[entitySummary[entityKind].titleField]) ||
              null
            : null
        }
        displayImage={
          record.success ? (record.data.displayImages?.[0] ?? null) : null
        }
      />
    );
  }

  if (isFetchableInlineEntity(entityKind) && query.isLoading) {
    return <Spinner className="text-muted-foreground" />;
  }

  if (isFetchableInlineEntity(entityKind) && query.data) {
    // SAFETY: entityPreviewQueryOptions selects a generated detail operation
    // whose fetchable-entity outputs all carry canonical displayImages.
    const data = query.data as { displayImages: ImageUrlSummary[] };
    return (
      <EntityInlineLink
        displayImage={data.displayImages[0] ?? null}
        entity={entityKind}
        // SAFETY: the preview query options and this discriminant are selected
        // by the same fetchable entity guard above.
        data={data as never}
        compact={compact}
      />
    );
  }

  // A fetchable type with no data → the entity was deleted. Any other type
  // (an audit row carrying an entityKind outside our union) → just label it.
  return (
    <span className="text-sm text-muted-foreground italic">
      {entityKind}
      {isFetchableInlineEntity(entityKind) ? " (deleted)" : ""}
    </span>
  );
}
