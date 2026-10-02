import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ReactNode } from "react";
import { z } from "zod";

import { entities, entityDetailParams } from "~/entity/entities";
import { renderCompactFieldValue } from "~/entity/entity-display";
import { ShelfCard, ShelfEmpty, ShelfGrid } from "~/ui/data-table/shelf";
import type { GroupConfig } from "~/ui/data-table/useGroupedList";
import type { ListGroupState } from "~/ui/hooks/progressive-list";
import type { InfiniteScrollControls } from "~/ui/hooks/useInfiniteTableList";

import { DeferredListValue } from "./deferred-list-value";

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
function shelfSubtitle(
  entity: BrowserRoutedEntity,
  row: ShelfRow,
  enrichmentState?: (id: string, field: string) => ListGroupState | undefined,
): ReactNode {
  const subtitle = entitySummary[entity].list.shelf?.subtitle ?? [];
  const fields = entityFieldModels[entity].fields;
  for (const key of subtitle) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    const state = enrichmentState?.(row.id, field.readKey ?? field.key);
    if (state && state.state !== "ready")
      return (
        <span className="block h-4 leading-4">
          <DeferredListValue state={state} />
        </span>
      );
    const value = row[field.readKey ?? field.key];
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    )
      continue;
    return renderCompactFieldValue(entity, row, field);
  }
  return enrichmentState && subtitle.length > 0 ? (
    <span className="block h-4" />
  ) : undefined;
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
  enrichmentState,
}: {
  entity: BrowserRoutedEntity;
  items: TRow[];
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
  compact?: boolean;
  groupConfig?: GroupConfig<TRow>;
  onInspect?: (record: TRow) => void;
  onRowHover?: (record: TRow) => void;
  onRowHoverEnd?: (record: TRow) => void;
  currentRowId?: string;
  onRetry?: () => void;
  enrichmentState?: (id: string, field: string) => ListGroupState | undefined;
}) {
  const { emptyState } = entitySummary[entity];
  return (
    <ShelfGrid
      items={items}
      isLoading={isLoading}
      error={error}
      infiniteScroll={infiniteScroll}
      compact={compact}
      groups={groupConfig?.groups}
      getGroupKey={groupConfig?.keyFn}
      onRetry={onRetry}
      emptyState={<ShelfEmpty entity={entity} label={emptyState.title} />}
      renderCard={(record) => {
        const row = shelfRowSchema.parse(record);
        const images = shelfImages(entity, row);
        const mediaState = enrichmentState?.(row.id, "displayImages");
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
            media={
              mediaState && mediaState.state !== "ready" ? (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  aria-label={
                    mediaState.state === "loading" ||
                    mediaState.state === "pending"
                      ? "Loading media"
                      : "Media unavailable"
                  }
                >
                  {mediaState.state === "error" ? (
                    <span className="p-3 text-xs text-destructive">
                      {mediaState.error}
                    </span>
                  ) : (
                    <DeferredListValue state={mediaState} label="media" />
                  )}
                </div>
              ) : undefined
            }
            extraCount={images.length - 1}
            title={shelfTitle(entity, row)}
            subtitle={shelfSubtitle(entity, row, enrichmentState)}
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
