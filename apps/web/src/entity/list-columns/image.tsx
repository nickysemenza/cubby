import type { ImageListFilters, ImageWithEntity } from "@cubby/schemas/image";
import { useMemo } from "react";

import { labeledFieldProvenance } from "~/entity/fields/field-provenance";
import { useFilenameEditable } from "~/entity/hooks/use-name-editable";
import { useImageUpdateMutation } from "~/entity/hooks/use-update-mutation";
import { ImageAssociationLinks } from "~/features/image/image-associations";
import { image } from "~/integrations/tanstack-query/generated/catalog.gen";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";

import { defineListOverride } from "./types";

// Image association types use uppercase storage labels; the list preview is
// keyed by the page's known "image" entity, so that storage-only field is not
// part of its browser row contract.
type ImageListRow = Omit<ImageWithEntity, "entityKind">;

const columnHelper = createCubbyColumnHelper<ImageListRow>();

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
      list: { ...IMAGE_LIST_OPTIONS, nameEditable },
    };
  },
});

const IMAGE_LIST_OPTIONS = { deletable: true as const };
