import {
  imageBrowserListInput,
  type ImageListFilters,
  type ImageWithEntity,
} from "@cubby/schemas/image";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";

import { createImageColumn } from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { useFilenameEditable } from "~/app/_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useImageUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { Badge } from "~/components/ui/badge";
import { labeledFieldProvenance } from "~/entities/field-provenance";
import { image } from "~/entities/image.functions";
import {
  IMPORT_RUN_TARGET_STATE_LABEL,
  IMPORT_RUN_TARGET_STATE_VARIANT,
  isImportRunTargetState,
} from "~/lib/import-run-target-state";

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
          // Only import-run targets (photo-inventory or a targeted purchase
          // enrichment) carry this — most images render an empty cell.
          add(
            columnHelper.accessor("importTarget", {
              header: "Import target",
              meta: {
                className: "w-32",
                mobile: { slot: "meta", priority: 25 },
              },
              cell: ({ getValue }) => {
                const state = getValue()?.state;
                if (!state) return null;
                return (
                  <Badge
                    variant={
                      isImportRunTargetState(state)
                        ? IMPORT_RUN_TARGET_STATE_VARIANT[state]
                        : "outline"
                    }
                  >
                    {isImportRunTargetState(state)
                      ? IMPORT_RUN_TARGET_STATE_LABEL[state]
                      : state}
                  </Badge>
                );
              },
            }),
          );
        }),
      [],
    );
    const compose = useMemo(
      () => (declared: CubbyColumnCollection<ImageListRow>) =>
        createCubbyColumnCollection<ImageListRow>((add) => {
          declared.filter((column) => column.id === "filename").visit(add);
          add(
            createImageColumn(columnHelper, {
              getImages: (row) => (row.status === "UPLOADED" ? [row] : []),
              entity: "image",
              provenance: null,
            }),
          );
          declared.filter((column) => column.id !== "filename").visit(add);
          add(
            columnHelper.accessor("associations", {
              id: "entity",
              header: "Associated Entities",
              meta: {
                provenance: labeledFieldProvenance("Entity associations"),
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
      list: { ...IMAGE_LIST_OPTIONS, nameEditable },
    };
  },
});

const IMAGE_LIST_OPTIONS = { deletable: true as const };
