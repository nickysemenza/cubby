import type { ImageWithEntity } from "@cubby/schemas/image";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";
import {
  createImageColumn,
  createNameColumn,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { imageStatusOptions } from "~/app/images/image-options";
import { usePageCount } from "~/components/page/Page";
import { useTRPC } from "~/integrations/trpc/react";
import { imageMutationInvalidateKeys, queryKeys } from "~/lib/query-keys";
import { UploadImageDialog } from "./upload-image-dialog";

/** Module-level so the deletable config keeps a stable identity. */
const IMAGE_INVALIDATE_KEYS = [queryKeys.image.list] as const;

export default function ImageList() {
  const api = useTRPC();
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<ImageWithEntity>(),
    [],
  );
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
        cell: ({ getValue }) =>
          renderOptionCell(getValue(), imageStatusOptions),
      }),
      // Associated entity
      columnHelper.accessor("associations", {
        id: "entity",
        header: "Associated Entities",
        meta: {
          className: "w-40",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: ({ getValue }) => (
          <ImageAssociationLinks associations={getValue()} compact />
        ),
      }),
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
