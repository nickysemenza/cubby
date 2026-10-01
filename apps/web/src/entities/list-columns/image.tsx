import {
  imageBrowserListInput,
  type ImageListFilters,
  type ImageWithEntity,
} from "@cubby/schemas/image";
import { useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { useFilenameEditable } from "~/app/_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useImageUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ImageAssociationLinks } from "~/app/_components/images/image-associations";
import { labeledFieldProvenance } from "~/entities/field-provenance";
import { image } from "~/integrations/tanstack-query/generated/catalog.gen";

import { defineListOverride } from "./types";

// Image association types use uppercase storage labels; the list preview is
// keyed by the page's known "image" entity, so that storage-only field is not
// part of its browser row contract.
type ImageListRow = Omit<ImageWithEntity, "entityKind">;

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
    const compose = useMemo(
      () => (declared: CubbyColumnCollection<ImageListRow>) =>
        createCubbyColumnCollection<ImageListRow>((add) => {
          declared.visit(add);
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
      compose,
      source: imageListSource,
      list: { ...IMAGE_LIST_OPTIONS, nameEditable },
    };
  },
});

const IMAGE_LIST_OPTIONS = { deletable: true as const };
