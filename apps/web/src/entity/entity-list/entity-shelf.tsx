import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ReactNode } from "react";
import { z } from "zod";

import { entities, entityDetailParams } from "~/entity/entities";
import type { InfiniteScrollControls } from "~/entity/hooks/use-infinite-table-list";
import { EntityEmptyState } from "~/entity/table/entity-empty-states";
import { ShelfCard, ShelfGrid } from "~/entity/table/shelf";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";

import { recordCaption } from "./record-caption";

/**
 * A list row as the shelf reads it: its id, its server-resolved cover
 * images, and whatever declared fields the caption names.
 */
const shelfRowSchema = z.looseObject({
  id: z.string(),
  displayImages: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        representations: z.object({ preferred: z.string() }).optional(),
      }),
    )
    .optional(),
});
type ShelfRow = z.infer<typeof shelfRowSchema>;

/** The record's title, the manifest's `titleField` (a non-nullable text read field). */
function shelfTitle(entity: BrowserRoutedEntity, row: ShelfRow): string {
  return (
    z.string().catch("").parse(row[entitySummary[entity].titleField]) || row.id
  );
}

// Image browser rows are the media record itself, not an entity carrying
// displayImages. Pending/failed uploads must remain icon tiles.
const imageBrowserMedia = z.object({
  id: z.string(),
  url: z.string(),
  status: z.literal("UPLOADED"),
});
// A card shows the server-preferred representation: the background-removed
// cutout when one is ready and the image is not pinned to its original.
function shelfImages(entity: BrowserRoutedEntity, row: ShelfRow) {
  if (entity !== "image")
    return (row.displayImages ?? []).map((image) => ({
      id: image.id,
      url: image.representations?.preferred ?? image.url,
    }));
  const image = imageBrowserMedia.safeParse(row);
  return image.success ? [image.data] : [];
}

/**
 * Photo-first "shelf" view of any entity that declares it: image-led cards
 * titled by `titleField`, pictured by the server-resolved `displayImages`,
 * captioned by `list.shelf.subtitle`. The data table stays one toggle away.
 */
export function EntityShelf<TRow extends { id: string }>({
  entity,
  items,
  isLoading,
  error,
  infiniteScroll,
  compact = false,
  groupConfig,
  onInspect,
  onRowHover,
  onRowHoverEnd,
  currentRowId,
  onRetry,
  emptyState,
}: {
  emptyState?: ReactNode;
  entity: BrowserRoutedEntity;
  items: TRow[];
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
  compact?: boolean;
  groupConfig?: GroupConfig;
  onInspect?: (record: TRow) => void;
  onRowHover?: (record: TRow) => void;
  onRowHoverEnd?: (record: TRow) => void;
  currentRowId?: string;
  onRetry?: () => void;
}) {
  return (
    <ShelfGrid
      items={items}
      isLoading={isLoading}
      error={error}
      infiniteScroll={infiniteScroll}
      compact={compact}
      grouping={groupConfig}
      getItemId={(record) => record.id}
      onRetry={onRetry}
      emptyState={emptyState ?? <EntityEmptyState entity={entity} />}
      renderCard={(record) => {
        const row = shelfRowSchema.parse(record);
        const images = shelfImages(entity, row);
        return (
          <ShelfCard
            key={row.id}
            record={record}
            to={entities[entity].routes.detail}
            params={
              entity === "usda-food"
                ? { id: row.id }
                : entityDetailParams(row.id)
            }
            image={images[0]?.url}
            extraCount={images.length - 1}
            title={shelfTitle(entity, row)}
            subtitle={recordCaption(entity, row)}
            entity={entity}
            compact={compact}
            onInspect={onInspect ? () => onInspect(record) : undefined}
            onRowHover={onRowHover ? () => onRowHover(record) : undefined}
            onRowHoverEnd={
              onRowHoverEnd ? () => onRowHoverEnd(record) : undefined
            }
            selected={currentRowId === row.id}
          />
        );
      }}
    />
  );
}
