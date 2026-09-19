import {
  imageBrowserListInput,
  type ImageListFilters,
  type ImageWithEntity,
} from "@cubby/schemas/image";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";

import {
  createImageColumn,
  createNameColumn,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { useFilenameEditable } from "~/app/_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useImageUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { imageStatusOptions } from "~/app/images/image-options";
import { image } from "~/entities/image.functions";

import { defineListOverride } from "./types";

// Image association types use uppercase storage labels; the list preview is
// keyed by the page's known "image" entity, so that storage-only field is not
// part of its browser row contract.
type ImageListRow = Omit<ImageWithEntity, "entityType">;

const columnHelper = createCubbyColumnHelper<ImageListRow>();

/** The image list is not a kernel list (no create contract): its own read. */
const imageListSource: ListQueryOptionsFn<ImageListFilters, ImageListRow> = (
  params,
) => {
  const input = imageBrowserListInput.parse(params);
  const policy = image.list.policy(input);
  return {
    queryKey: image.list.queryKey(input),
    meta: policy.meta,
    execute: (signal) => image.list.call(input, { signal }),
  };
};

export const imageListOverride = defineListOverride<
  ImageListRow,
  ImageListFilters
>({
  use() {
    const updateImageMutation = useImageUpdateMutation({
      mutationFn: () => image.update.mutationOptions(),
    });
    const nameEditable = useFilenameEditable<ImageListRow>(
      updateImageMutation.mutateAsync,
    );
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<ImageListRow>((add) => {
          add(
            createNameColumn(columnHelper, "image", "filename", {
              header: "Filename",
              editable: nameEditable,
              filterConfig: { placeholder: "Filter by filename..." },
            }),
          );
          add(
            columnHelper.accessor("size", {
              header: "Size",
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "trailing", priority: 5 },
              },
              cell: ({ getValue }) => <span>{prettyBytes(getValue())}</span>,
            }),
          );
          add(
            columnHelper.accessor("status", {
              header: "Status",
              meta: {
                className: "w-28",
                mobile: { slot: "meta", priority: 20 },
              },
              cell: ({ getValue }) =>
                renderOptionCell(getValue(), imageStatusOptions),
            }),
          );
        }),
      [nameEditable],
    );
    const compose = useMemo(
      () => (declared: CubbyColumnCollection<ImageListRow>) =>
        createCubbyColumnCollection<ImageListRow>((add) => {
          declared.filter((column) => column.id === "filename").visit(add);
          add(
            createImageColumn(columnHelper, {
              getImages: (row) => (row.status === "UPLOADED" ? [row] : []),
              entity: "image",
            }),
          );
          declared.filter((column) => column.id !== "filename").visit(add);
          add(
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
          );
        }),
      [],
    );
    return {
      overrides,
      compose,
      source: imageListSource,
      list: IMAGE_LIST_OPTIONS,
    };
  },
});

const IMAGE_LIST_OPTIONS = { deletable: true as const };
