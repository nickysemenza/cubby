import {
  imageBrowserListInput,
  type ImageListFilters,
  type ImageWithEntity,
} from "@cubby/schemas/image";
import prettyBytes from "pretty-bytes";
import { useCallback, useMemo } from "react";

import {
  createImageColumn,
  createNameColumn,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import { EntityListPage } from "~/app/_components/data-table/EntityListPage";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useFilenameEditable } from "~/app/_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useImageUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { imageStatusOptions } from "~/app/images/image-options";
import { image } from "~/entities/image.functions";

import { UploadImageDialog } from "./upload-image-dialog";

// Image association types use uppercase storage labels. The list preview is
// keyed by the page's known "image" entity, so that storage-only field is not
// part of its browser row contract.
type ImageListRow = Omit<ImageWithEntity, "entityType">;

export default function ImageList() {
  const queryOptions = useCallback<ListQueryOptionsFn<ImageListFilters>>(
    (params) => image.list.queryOptions(imageBrowserListInput.parse(params)),
    [],
  );
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<ImageListRow>(),
    [],
  );

  const updateImageMutation = useImageUpdateMutation({
    mutationFn: () => image.update.mutationOptions(),
  });
  const nameEditable = useFilenameEditable<ImageListRow>(
    updateImageMutation.mutateAsync,
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

  return (
    <EntityListPage<ImageListRow, ImageListFilters>
      entity="image"
      queryOptions={queryOptions}
      columns={columns}
      deletable
      ariaLabel="Images Table"
      actions={<UploadImageDialog />}
    />
  );
}
