import type { Entity } from "@cubby/schemas/entity";
import type { LocationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/schemas/product";
import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";
import { ProjectMark } from "~/app/projects/project-mark";
import { IconTile } from "~/components/ui/icon-tile";
import { Image } from "~/components/ui/image";
import { EntityIcon, entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { pushRecent } from "../command-menu/recents";
import {
  getLocationIcon,
  getLocationTypeColor,
} from "../locations/location-type-theme";
import { getCategoryColor, getCategoryIcon } from "../products/category-theme";

export type { SearchHit } from "@cubby/schemas/search";

export const entityTypeMap: Record<SearchableEntity, Entity> = {
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
};

function getSearchResultEntity(item: SearchHit): Entity {
  return entityTypeMap[item.entityType];
}

export function getSearchResultRoute(item: SearchHit) {
  const entity = getSearchResultEntity(item);
  return {
    to: entities[entity].routes.detail,
    params: entityDetailParams(item.id),
  };
}

export function rememberSearchResult(item: SearchHit): void {
  pushRecent({ entityType: item.entityType, id: item.id, name: item.title });
}

function SearchHitIcon({
  item,
  className = "size-4 shrink-0",
}: {
  item: SearchHit;
  className?: string;
}) {
  const entity = entityTypeMap[item.entityType];
  if (item.entityType === "project")
    return <ProjectMark icon={item.typeHint} className={className} />;
  if (item.entityType === "location" && item.typeHint) {
    const Icon = getLocationIcon(item.typeHint as LocationType);
    return (
      <Icon
        className={className}
        style={{ color: getLocationTypeColor(item.typeHint as LocationType) }}
      />
    );
  }
  if (
    (item.entityType === "product" || item.entityType === "inventory") &&
    item.typeHint
  ) {
    const Icon = getCategoryIcon(item.typeHint as ProductCategory);
    return (
      <Icon
        className={className}
        style={{ color: getCategoryColor(item.typeHint as ProductCategory) }}
      />
    );
  }
  return <EntityIcon entity={entity} colored className={className} />;
}

const mediaVariants = {
  command: {
    tile: "size-8 rounded",
    icon: "size-4 shrink-0",
    displayWidth: 64,
  },
  list: { tile: "size-10 rounded", icon: "size-5 shrink-0", displayWidth: 80 },
  mobile: {
    tile: "size-11 rounded",
    icon: "size-5 shrink-0",
    displayWidth: 88,
  },
} as const;

export function SearchResultMedia({
  item,
  variant = "command",
}: {
  item: SearchHit;
  variant?: keyof typeof mediaVariants;
}) {
  const media = mediaVariants[variant];
  const entity = getSearchResultEntity(item);
  if (item.imageUrl)
    return (
      <Image
        src={item.imageUrl}
        alt=""
        displayWidth={media.displayWidth}
        className={cn("shrink-0 object-cover", media.tile)}
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

const matchKindLabel = {
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
