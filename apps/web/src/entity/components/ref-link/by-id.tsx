import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import { imageUrlSummary } from "@cubby/schemas/image-summary";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";

import { entityLabel, isBrowserRoutedEntity } from "~/entity/entities";
import {
  entityPreviewQueryOptions,
  isDetailEntity,
} from "~/entity/entity-query";
import { readRecordField } from "~/entity/entity-references";
import type { DetailEntity } from "~/entity/generated/entity-details.gen";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Spinner } from "~/ui/primitives/spinner";

import { InlineRefLink } from "./inline";
import { ChipRefLink } from "./leaf";

const isNamedEntity = (
  entity: Entity,
): entity is DetailEntity & BrowserRoutedEntity =>
  isBrowserRoutedEntity(entity) && isDetailEntity(entity);

const namedRecordSchema = z.looseObject({
  emoji: z.string().nullish(),
});

// These detail records retain their richer inline relationship presentation.
const FETCHABLE = [
  "product",
  "location",
  "recipe",
  "ingredient",
] as const satisfies readonly Entity[];
type FetchableEntity = (typeof FETCHABLE)[number];

const isFetchableEntity = (entity: Entity): entity is FetchableEntity =>
  FETCHABLE.some((candidate) => candidate === entity);

type ByIdRefLinkProps = {
  entityKind: Entity;
  entityId: string;
  name?: string | null;
  bare?: boolean;
};

/**
 * A "smart" link that fetches entity data by ID and renders the appropriate
 * link. Uses React Query caching so multiple links with the same ID won't
 * cause duplicate fetches.
 */
export function ByIdRefLink({
  entityKind,
  entityId,
  name,
  bare,
}: ByIdRefLinkProps) {
  const hydrated = useHydrated();
  // Legacy audit references carried UUIDs for these kinds; only public record
  // shortcodes may enter the detail transport or a record URL.
  const legacyReference =
    (entityKind === "inventory" || entityKind === "cookbook") &&
    !shortcodeSchema(entityKind).safeParse(entityId).success;
  // Unsupported runtime kinds and legacy UUID references skip the query.
  const queryOptions = useMemo(
    () =>
      isNamedEntity(entityKind) && !legacyReference && !name
        ? entityPreviewQueryOptions(entityKind, entityId)
        : { queryKey: ["invalid"] as const, queryFn: skipToken },
    [entityKind, entityId, name, legacyReference],
  );

  // SAFETY: the options union is narrowed by the named entity guard, but
  // React Query's generic overload cannot express that correlation.
  const query = useQuery(queryOptions as never);

  if (entityKind === "inventory" && legacyReference) {
    return <span className="text-sm font-medium">Inventory Entry</span>;
  }

  if (entityKind === "cookbook" && legacyReference) {
    return (
      <a href="/cookbooks" className="text-sm font-medium hover:underline">
        Cookbook
      </a>
    );
  }

  if (name && isNamedEntity(entityKind)) {
    return (
      <ChipRefLink entity={entityKind} id={entityId} name={name} bare={bare} />
    );
  }

  // The SSR query stream may settle before hydration. Both initial renders
  // must retain the loading label rather than disagree on the linked name.
  if (isNamedEntity(entityKind) && (!hydrated || query.isPending)) {
    return (
      <output className="inline-flex items-center gap-1 text-muted-foreground">
        <Spinner aria-hidden className="size-3" /> Loading…
      </output>
    );
  }
  if (isNamedEntity(entityKind) && query.isError)
    return <span className="text-destructive">{query.error.message}</span>;

  if (!isFetchableEntity(entityKind) && isNamedEntity(entityKind)) {
    // Every other generated entity names itself through its manifest
    // `titleField`; a bare shortcode link (`PRJ-4UMD`) says nothing to a reader.
    const record = namedRecordSchema.safeParse(query.data);
    return (
      <ChipRefLink
        entity={entityKind}
        id={entityId}
        bare={bare}
        emoji={record.success ? record.data.emoji : undefined}
        name={
          record.success
            ? readRecordField(
                record.data,
                entityRoster[entityKind].titleField,
                z.string().catch(""),
              ) || `Untitled ${entityLabel(entityKind).toLowerCase()}`
            : `Missing ${entityLabel(entityKind).toLowerCase()}`
        }
        // Absent stays `undefined` so the chip falls back to the surrounding
        // display-image provider's cover.
        displayImage={
          record.success
            ? readRecordField(
                record.data,
                "displayImages",
                z.array(imageUrlSummary).nullish(),
              )?.[0]
            : undefined
        }
      />
    );
  }

  if (isFetchableEntity(entityKind) && query.data) {
    const cover = readRecordField(
      query.data,
      "displayImages",
      z.array(imageUrlSummary).nullish(),
    )?.[0];
    return (
      <InlineRefLink
        displayImage={cover ?? null}
        entity={entityKind}
        // SAFETY: the preview query options and this discriminant are selected
        // by the same fetchable entity guard above.
        data={query.data as never}
        bare={bare}
      />
    );
  }

  // A fetchable type with no data → the entity was deleted. Any other type
  // (an audit row carrying an entityKind outside our union) → just label it.
  return (
    <span className="text-sm text-muted-foreground italic">
      {entityKind}
      {isFetchableEntity(entityKind) ? " (deleted)" : ""}
    </span>
  );
}
