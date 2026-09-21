import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  SearchableEntity,
  SearchDestination,
  SearchHit,
} from "@cubby/schemas/search";
import { locationTypeValues } from "@cubby/shared";

import { ProjectMark } from "~/app/projects/project-mark";
import { EntityCover } from "~/components/entity/entity-cover";
import { IconTile } from "~/components/ui/icon-tile";
import { EntityIcon, entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";

import {
  getLocationIcon,
  getLocationTypeColor,
} from "../locations/location-type-theme";

export type { SearchHit } from "@cubby/schemas/search";

export const entityTypeMap = {
  product: "product",
  recipe: "recipe",
  ingredient: "ingredient",
  cookbook: "cookbook",
  location: "location",
  inventory: "inventory",
  meal: "meal",
  project: "project",
  task: "task",
  vendor: "vendor",
  purchase: "purchase",
  financialAccount: "financialAccount",
  financialTransaction: "financialTransaction",
  expense: "expense",
  wish: "wish",
  image: "image",
  planting: "planting",
  gardenEntry: "gardenEntry",
} satisfies Record<SearchableEntity, BrowserRoutedEntity>;

function getSearchResultEntity(item: SearchDestination): BrowserRoutedEntity {
  return entityTypeMap[item.entityType];
}

export function getSearchResultRoute(item: SearchDestination) {
  const entity = getSearchResultEntity(item);
  return {
    to: entities[entity].routes.detail,
    params: entityDetailParams(item.id),
  };
}

/** String href for the same route as `getSearchResultRoute`, for `MobileCard`'s `detailsHref`. */
export function getSearchResultHref(item: SearchDestination): string {
  return `/${entities[getSearchResultEntity(item)].basePath}/${item.id}`;
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
 * types as `LucideIcon`, and the `as` is what makes the claim false.
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
  const entity = entityTypeMap[item.entityType];
  if (item.entityType === "project")
    return <ProjectMark icon={item.typeHint} className={className} />;
  const locationType =
    item.entityType === "location" ? asLocationType(item.typeHint) : undefined;
  if (locationType) {
    const Icon = getLocationIcon(locationType);
    return (
      <Icon
        className={className}
        style={{ color: getLocationTypeColor(locationType) }}
      />
    );
  }
  return <EntityIcon entity={entity} colored className={className} />;
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
  const entity = getSearchResultEntity(item);
  if (item.imageUrl)
    return (
      <EntityCover
        images={[{ id: item.id, url: item.imageUrl }]}
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
