import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import {
  preferredImageUrl,
  publicImageUrl,
  publicImageUrlSummary,
} from "@cubby/schemas/image-summary";
import { countLabel } from "@cubby/shared/pluralize";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { entities, browserEntityDetailParams } from "~/entity/entities";
import type { InfiniteScrollControls } from "~/entity/hooks/use-infinite-table-list";
import { useEntityMetadata } from "~/entity/metadata";
import { rowDisplayCover } from "~/entity/model/row-display-cover";
import { readPathValue } from "~/entity/read-path";
import { EntityEmptyState } from "~/entity/table/entity-empty-states";
import { ShelfCard, ShelfGrid } from "~/entity/table/shelf";
import { Picker } from "~/ui/combobox/picker";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { Image } from "~/ui/media/image";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

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
    z
      .string()
      .catch("")
      .parse(readPathValue(row, entityRoster[entity].titleField)) || row.id
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
    const { image } = rowDisplayCover(row);
    return image ? [{ id: image.id, url: preferredImageUrl(image) }] : [];
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
  contactSheet = false,
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
  contactSheet?: boolean;
  groupConfig?: GroupConfig;
  onInspect?: (record: TRow) => void;
  onRowHover?: (record: TRow) => void;
  onRowHoverEnd?: (record: TRow) => void;
  currentRowId?: string;
  onRetry?: () => void;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const [imageFit, setImageFit] = useState<"fit" | "fill">("fit");
  const omitted = contactSheet
    ? items.filter(
        (record) =>
          shelfImages(entity, shelfRowSchema.parse(record)).length === 0,
      ).length
    : 0;
  return (
    <>
      {contactSheet && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Picker
            mode="segmented"
            label="Image fit"
            value={imageFit}
            onValueChange={(value) => {
              if (value === "fit" || value === "fill") setImageFit(value);
            }}
            options={[
              { value: "fit", label: "Fit" },
              { value: "fill", label: "Fill" },
            ]}
          />
          <span>{countLabel(omitted, "loaded record")} without images</span>
          {!isLoading && items.length > 0 && omitted === items.length && (
            <span>No images in the loaded records.</span>
          )}
        </div>
      )}
      {/* Keep unpictured rows in the lifecycle so an all-unpictured page still loads the next page. */}
      <ShelfGrid
        items={items}
        isLoading={isLoading}
        error={error}
        infiniteScroll={infiniteScroll}
        compact={compact}
        contactSheet={contactSheet}
        grouping={groupConfig}
        getItemId={(record) => record.id}
        onRetry={onRetry}
        emptyState={emptyState ?? <EntityEmptyState entity={entity} />}
        renderCard={(record) => {
          const row = shelfRowSchema.parse(record);
          const images = shelfImages(entity, row);
          const title = shelfTitle(entity, row);
          const params = browserEntityDetailParams(entity, row.id);
          if (contactSheet) {
            const image = images[0];
            if (!image) return null;
            return (
              <Tooltip key={row.id}>
                <TooltipTrigger
                  render={
                    <Link
                      to={entities[entity].routes.detail}
                      params={params}
                      aria-label={title}
                      aria-current={
                        currentRowId === row.id ? "true" : undefined
                      }
                      className="relative block size-8 overflow-hidden bg-muted/20 hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-current:outline-2 aria-current:-outline-offset-2 aria-current:outline-ring"
                      onMouseEnter={
                        onRowHover ? () => onRowHover(record) : undefined
                      }
                      onMouseLeave={
                        onRowHoverEnd ? () => onRowHoverEnd(record) : undefined
                      }
                      onClick={(event) => {
                        if (
                          !onInspect ||
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.altKey ||
                          event.shiftKey
                        )
                          return;
                        event.preventDefault();
                        onInspect(record);
                      }}
                    />
                  }
                >
                  <Image
                    src={image.url}
                    alt=""
                    displayWidth={32}
                    className={
                      imageFit === "fit"
                        ? "absolute inset-0 size-full object-contain"
                        : "absolute inset-0 size-full object-cover"
                    }
                  />
                </TooltipTrigger>
                <TooltipContent role="tooltip">{title}</TooltipContent>
              </Tooltip>
            );
          }
          return (
            <ShelfCard
              key={row.id}
              record={record}
              to={entities[entity].routes.detail}
              params={params}
              image={images[0]?.url}
              extraCount={
                (entity === "image"
                  ? images.length
                  : rowDisplayCover(row).count) - 1
              }
              title={title}
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
    </>
  );
}
