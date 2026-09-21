import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  ShelfCard,
  ShelfEmpty,
  ShelfGrid,
} from "~/app/_components/data-table/shelf";
import type { InfiniteScrollControls } from "~/app/_components/hooks/useInfiniteTableList";
import { entities, entityDetailParams } from "~/entities/entities";
import { renderDetailFieldValue } from "~/entities/entity-display";

/**
 * A list row as the shelf reads it: its id, its server-resolved cover
 * images, and whatever declared fields the caption names.
 */
const shelfRowSchema = z.looseObject({
  id: z.string(),
  displayImages: z
    .array(z.object({ id: z.string(), url: z.string() }))
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
function shelfImages(entity: BrowserRoutedEntity, row: ShelfRow) {
  if (entity !== "image") return row.displayImages ?? [];
  const image = imageBrowserMedia.safeParse(row);
  return image.success ? [image.data] : [];
}

/**
 * The caption is the first declared `shelf.subtitle` field with a value,
 * rendered through its declared format — a price reads as money, a category
 * as its label.
 */
function shelfSubtitle(entity: BrowserRoutedEntity, row: ShelfRow): ReactNode {
  const subtitle = entitySummary[entity].list.shelf?.subtitle ?? [];
  const fields = entityFieldModels[entity].fields;
  for (const key of subtitle) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    const value = row[field.readKey ?? field.key];
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    )
      continue;
    return renderDetailFieldValue(entity, row, field);
  }
  return undefined;
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
  onInspect,
  onRowHover,
  onRowHoverEnd,
  currentRowId,
  onRetry,
}: {
  entity: BrowserRoutedEntity;
  items: TRow[];
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
  compact?: boolean;
  onInspect?: (record: TRow) => void;
  onRowHover?: (record: TRow) => void;
  onRowHoverEnd?: (record: TRow) => void;
  currentRowId?: string;
  onRetry?: () => void;
}) {
  const { emptyState } = entitySummary[entity];
  return (
    <ShelfGrid
      items={items}
      isLoading={isLoading}
      error={error}
      infiniteScroll={infiniteScroll}
      compact={compact}
      onRetry={onRetry}
      emptyState={<ShelfEmpty entity={entity} label={emptyState.title} />}
      renderCard={(record) => {
        const row = shelfRowSchema.parse(record);
        const images = shelfImages(entity, row);
        return (
          <ShelfCard
            key={row.id}
            to={entities[entity].routes.detail}
            params={
              entity === "usda-food"
                ? { id: row.id }
                : entityDetailParams(row.id)
            }
            image={images[0]?.url}
            extraCount={images.length - 1}
            title={shelfTitle(entity, row)}
            subtitle={shelfSubtitle(entity, row)}
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
