import type { SearchDestination, SearchHit } from "@cubby/schemas/search";
import { locationTypeValues } from "@cubby/shared";

import { EntityCover } from "~/entity/components/entity-cover";
import { RecordEmoji } from "~/entity/components/record-emoji";
import { EntityIcon, entities, entityDetailParams } from "~/entity/entities";
import { cn } from "~/lib/utils";
import { IconTile } from "~/ui/primitives/icon-tile";

import { getLocationIcon, getLocationTypeColor } from "./location-type-theme";

export type { SearchHit } from "@cubby/schemas/search";

/**
 * Identifying context under a hit's title: the declared facts, else the
 * projection's subtitle, so kinds without facts keep what tells same-titled
 * hits apart.
 */
export function searchHitContext(item: SearchDestination): string | null {
  return item.facts.length > 0 ? item.facts.join(" · ") : item.subtitle;
}

export function getSearchResultRoute(item: SearchDestination) {
  const entity = item.entityKind;
  return {
    to: entities[entity].routes.detail,
    params: entityDetailParams(item.id),
  };
}

/** String href for the same route as `getSearchResultRoute`, for `MobileCard`'s `detailsHref`. */
export function getSearchResultHref(item: SearchDestination): string {
  return `/${entities[item.entityKind].basePath}/${item.id}`;
}

/**
 * `typeHint` is whatever string the `SearchDocument` row was written with, NOT
 * a validated enum member — a row keeps its hint until it is reindexed, so
 * retired values outlive the enum. The location enum went 16 → 9 and left
 * `quarter-crate`, `crate`, `half-crate`, `tote-27gal`, `milk-crate`, and the
 * other tote sizes behind on live rows.
 *
 * The icon Records are deliberately exhaustive over the CURRENT enum, so
 * casting a stale hint into one (`hint as LocationType`) returns `undefined` —
 * and rendering `<undefined />` is React error #130, which takes down the whole
 * command menu. Searching "quarter" did exactly that. `noUncheckedIndexedAccess`
 * cannot catch it: a finite-key Record is not an index signature, so the lookup
 * types as `Icon`, and the `as` is what makes the claim false.
 *
 * Narrowing by membership keeps the Records exhaustive (their compile-time
 * guarantee is load-bearing) while letting an unrecognized hint fall through to
 * the entity's own icon. `find` returns the literal union, so there is no cast.
 */
function asLocationType(hint: string | null | undefined) {
  return locationTypeValues.find((value) => value === hint);
}

function SearchHitIcon({
  item,
  className = "size-4 shrink-0",
}: {
  item: SearchDestination;
  className?: string;
}) {
  const entity = item.entityKind;
  if (item.emoji)
    return (
      <RecordEmoji
        entity={item.entityKind}
        emoji={item.emoji}
        className={className}
      />
    );
  const locationType =
    item.entityKind === "location" ? asLocationType(item.typeHint) : undefined;
  if (locationType) {
    const Icon = getLocationIcon(locationType);
    return (
      <Icon
        className={className}
        style={{ color: getLocationTypeColor(locationType) }}
      />
    );
  }
  return <EntityIcon entity={entity} className={className} />;
}

const mediaVariants = {
  command: {
    tile: "size-8",
    icon: "size-4 shrink-0",
    size: 32,
  },
  list: { tile: "size-10", icon: "size-5 shrink-0", size: 40 },
  mobile: {
    tile: "size-11",
    icon: "size-5 shrink-0",
    size: 44,
  },
} as const;

export function SearchResultMedia({
  item,
  variant = "command",
}: {
  item: SearchDestination;
  variant?: keyof typeof mediaVariants;
}) {
  const media = mediaVariants[variant];
  const entity = item.entityKind;
  if (item.imageUrl)
    return (
      <EntityCover
        images={[{ url: item.imageUrl }]}
        entity={entity}
        alt=""
        size={media.size}
      />
    );
  return (
    <IconTile
      size={variant === "mobile" ? "lg" : "md"}
      className={cn(
        media.tile,
        entities[entity]?.color.bg ?? "bg-muted/50",
        entities[entity]?.color.text,
      )}
    >
      <SearchHitIcon item={item} className={media.icon} />
    </IconTile>
  );
}

/**
 * How a hit was found, in the user's words. Exported because the pickers label
 * their semantic-fallback group with the same word the search results use —
 * "Related" meaning the same thing in both places is the whole point.
 */
export const matchKindLabel = {
  exact: "Exact match",
  prefix: "Starts with",
  text: "Text match",
  fuzzy: "Possible typo",
  semantic: "Related",
} as const;
export function getSearchMatchText(item: SearchHit): string {
  return (
    item.matchReason ||
    `${matchKindLabel[item.matchKind]} in ${item.matchField}`
  );
}
