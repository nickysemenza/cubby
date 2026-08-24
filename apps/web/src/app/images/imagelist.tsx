import type { ImageWithEntity } from "@cubby/schemas/image";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";
import {
  createImageColumn,
  createNameColumn,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import { EntityListPage } from "~/app/_components/data-table/EntityListPage";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { imageStatusOptions } from "~/app/images/image-options";
import { useTRPC } from "~/integrations/trpc/react";
import { UploadImageDialog } from "./upload-image-dialog";

export default function ImageList() {
  const api = useTRPC();
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<ImageWithEntity>(),
    [],
  );

  const updateImageMutation = useUpdateMutation({
    mutationFn: api.image.update.mutationOptions,
    entity: "image",
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

  return (
    <EntityListPage<ImageWithEntity>
      entity="image"
      columns={columns}
      deletable
      ariaLabel="Images Table"
      actions={<UploadImageDialog />}
    />
  );
}
