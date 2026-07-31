import type { EntityImage } from "@cubby/schemas/entity";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { createColumnHelper } from "@tanstack/react-table";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";
import {
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { usePageCount } from "~/components/page/Page";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { imageMutationInvalidateKeys, queryKeys } from "~/lib/query-keys";
import { UploadImageDialog } from "./upload-image-dialog";

/** Module-level so the deletable config keeps a stable identity. */
const IMAGE_INVALIDATE_KEYS = [queryKeys.image.list] as const;

/**
 * Owning-entity kind → EntityInlineLink entity. A full Record over
 * `EntityImage` on purpose: adding a new image-owner enum member is a compile
 * error until it's mapped here (a missing key used to flow `undefined` into
 * EntityInlineLink's exhaustive ts-pattern match and crash the whole page —
 * that's how PROJECT-owned images broke /images). `null` = no inline-link arm
 * exists; the cell falls back to plain text.
 */
const IMAGE_ENTITY_LINK_KIND: Record<
  EntityImage,
  "product" | "location" | "recipe" | "project" | "purchase" | null
> = {
  PRODUCT: "product",
  LOCATION: "location",
  RECIPE: "recipe",
  PROJECT: "project",
  COOKBOOK: null,
  PURCHASE: "purchase",
};

export default function ImageList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<ImageWithEntity>(), []);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("image");

  // Images DO have a `deletedAt` column (like every other entity), but
  // `deleteImages` intentionally hard-deletes anyway — see its doc comment in
  // server/repo/image.ts. Restore was never implemented for any entity, and
  // an orphaned image (no owning product/location/recipe/project) has no use
  // once removed, so there's no reason to carry the soft-delete indirection.
  const deletableConfig = useDeletableConfig({
    mutationFn: api.image.delete.mutationOptions,
    entityLabel: "Image",
    invalidateKeys: IMAGE_INVALIDATE_KEYS,
    entity: "image",
  });

  const updateImageMutation = useUpdateMutation({
    mutationFn: api.image.update.mutationOptions,
    entity: "image",
    invalidateKeys: imageMutationInvalidateKeys,
  });
  // Images use `filename`, not `name` — see useNameEditable's `field` param.
  const nameEditable = useNameEditable<ImageWithEntity, "filename">(
    updateImageMutation.mutateAsync,
    "filename",
  );

  // Memoize columns to prevent recreating on every render (feeds the
  // useStandardColumns columns memo, which now re-runs on identity change).
  const columns = useMemo(
    () => [
      // Filename column: links to the detail page, inline-editable.
      createNameColumn(columnHelper, "image", "filename", {
        header: "Filename",
        editable: nameEditable,
        filterConfig: { placeholder: "Filter by filename..." },
      }),
      // Preview column
      createImageColumn(columnHelper, {
        getImages: (row) => (row.status === "UPLOADED" ? [row] : []),
        entity: "image",
      }),
      // Content type
      columnHelper.accessor("contentType", {
        header: "Type",
        meta: {
          className: "w-28",
          mobile: { slot: "subtitle", priority: 10 },
        },
        cell: ({ getValue }) => <span>{getValue()}</span>,
      }),
      // File size
      columnHelper.accessor("size", {
        header: "Size",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "trailing", priority: 5 },
        },
        cell: ({ getValue }) => <span>{prettyBytes(getValue())}</span>,
      }),
      // Status
      columnHelper.accessor("status", {
        header: "Status",
        meta: {
          className: "w-28",
          mobile: { slot: "meta", priority: 20 },
        },
        cell: ({ getValue }) => {
          const status = getValue();
          return <ImageStatusBadge status={status} />;
        },
      }),
      // Associated entity
      columnHelper.accessor(
        (row) => ({
          entityType: row.entityType,
          entityId: row.entityId,
          entityName: row.entityName,
        }),
        {
          id: "entity",
          header: "Associated Entity",
          meta: {
            className: "w-40",
            mobile: { slot: "meta", priority: 30 },
          },
          cell: ({ getValue }) => {
            const { entityType, entityId, entityName } = getValue();

            if (!entityType || !entityId || !entityName) {
              return <NoneValue />;
            }

            const entity = IMAGE_ENTITY_LINK_KIND[entityType];
            if (!entity) {
              // Owner kind without an EntityInlineLink arm (COOKBOOK today) —
              // show the name as plain text rather than crashing the page.
              return <span className="truncate">{entityName}</span>;
            }

            // A purchase has no `name` column, so its inline-link arm takes the
            // charge's identity fields instead. The image row's `entityName` is
            // already the resolved charge label (the vendor's order id), so it
            // feeds `orderId` — `purchaseLabel` then renders it verbatim.
            if (entity === "purchase") {
              return (
                <EntityInlineLink
                  entity="purchase"
                  data={{ id: entityId, orderId: entityName }}
                  compact
                />
              );
            }

            return (
              <EntityInlineLink
                entity={entity}
                data={{ id: entityId, name: entityName }}
                compact
              />
            );
          },
        },
      ),
    ],
    [columnHelper, nameEditable],
  );

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList({
    entity: "image",
    queryOptions: (params) => api.image.list.queryOptions(params),
    columns,
    deletable: deletableConfig,
  });
  usePageCount(totalCount);

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Images Table"
        timing={timing}
        entity="image"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        actions={<UploadImageDialog />}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      {deleteDialog}
      <PreviewSheet />
    </div>
  );
}
