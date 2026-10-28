import { displayImagesField } from "@cubby/schemas/display-images";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  preferredImageUrl,
  publicImageUrl,
  publicImageUrlSummary,
} from "@cubby/schemas/image-summary";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

import { entities, entityDetailParams } from "~/entity/entities";
import type { InfiniteScrollControls } from "~/entity/hooks/use-infinite-table-list";
import { useEntityMetadata } from "~/entity/metadata";
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
});
type ShelfRow = z.infer<typeof shelfRowSchema>;

/** The record's title, the manifest's `titleField` (a non-nullable text read field). */
function shelfTitle(entity: BrowserRoutedEntity, row: ShelfRow): string {
  return (
    z.string().catch("").parse(row[entityRoster[entity].titleField]) || row.id
  );
}

// Image browser rows are the media record itself, not an entity carrying
// displayImages. Pending/failed uploads must remain icon tiles.
const imageBrowserMedia = publicImageUrlSummary.extend({
  id: z.string(),
  status: z.literal("UPLOADED"),
});
// A card shows the server-preferred representation: the background-removed
// cutout when one is ready and the image is not pinned to its original.
function shelfImages(entity: BrowserRoutedEntity, row: ShelfRow) {
  if (entity !== "image") {
    const envelope = fieldEnvelopeFor(row, "displayImages");
    const images = envelope
      ? displayImagesField.nullable().parse(fieldValueOf(envelope))
      : null;
    return (images ?? []).map((image) => ({
      id: image.id,
      url: preferredImageUrl(image),
    }));
  }
  const image = imageBrowserMedia.safeParse(row);
  const url = image.success ? publicImageUrl(image.data) : undefined;
  return image.success && url ? [{ id: image.data.id, url }] : [];
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
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
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
            subtitle={recordCaption(queryClient, entity, row)}
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
