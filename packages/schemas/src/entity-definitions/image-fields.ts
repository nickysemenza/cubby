import { z } from "zod";
import { imageShortcode } from "../identifier-fields.js";
import { imageOut } from "./field-primitives.js";

const imageRelation = { entity: "image", relation: "images" };

/**
 * The `images` read of an entity with its own gallery. The label names the
 * entity in the field explanation, which web, native and MCP all show.
 */
export const galleryImagesField = <Read extends z.ZodType>(
  entity: string,
  label: string,
  read: Read,
) => ({
  key: "images" as const,
  kind: "json" as const,
  display: { detail: false as const, standard: "image" as const },
  provenance: { kind: "derived" as const, sources: [imageRelation] },
  explanation: {
    ruleId: `${entity}.images`,
    description: `${label} images are the current live Image attachments in canonical attachment order; list and summary surfaces use the same selected images through the display-image projection.`,
    projections: {
      list: "displayImages",
      detail: "images",
      summary: "displayImages",
    },
    sourceDependencies: [
      {
        path: "displayImages",
        label: `Selected ${label.toLowerCase()} images`,
      },
    ],
  },
  validation: { read, create: null, update: null },
});

/** The `images` field of an entity showing another record's images. */
export const borrowedImagesField = (
  sources: { entity: string; relation: string }[],
) => ({
  output: false as const,
  key: "images" as const,
  kind: "json" as const,
  display: { standard: "image" as const },
  provenance: { kind: "derived" as const, sources },
  validation: { read: z.array(imageOut), create: null, update: null },
});

const imageIdsInput = () => z.array(imageShortcode).optional();
const writeOnly = { output: false as const, audit: false as const };
const multipleImages = { entity: "image" as const, multiple: true as const };
const picker = {
  control: {
    kind: "specialized" as const,
    renderer: "entity-multi-select",
  },
};

/** Gallery edits in one update: images to add, images to remove, and the new order. */
export const galleryWriteFields = ({
  pickers = false,
  orderControl = pickers,
  order = imageIdsInput(),
}: {
  /** Editors choose images to add and remove with the shared picker. */
  pickers?: boolean;
  /** Editors reorder images with the shared control. */
  orderControl?: boolean;
  order?: ReturnType<typeof imageIdsInput>;
} = {}) =>
  [
    {
      ...writeOnly,
      key: "pendingImageIds" as const,
      kind: "identifier" as const,
      reference: multipleImages,
      ...(pickers ? picker : {}),
      validation: {
        read: null,
        create: imageIdsInput(),
        update: imageIdsInput(),
      },
    },
    {
      ...writeOnly,
      key: "removeImageIds" as const,
      kind: "identifier" as const,
      reference: multipleImages,
      ...(pickers ? picker : {}),
      validation: { read: null, create: null, update: imageIdsInput() },
    },
    {
      ...writeOnly,
      key: "imageOrder" as const,
      semanticRole: "attachment" as const,
      kind: "text" as const,
      ...(orderControl
        ? {
            control: {
              kind: "specialized" as const,
              renderer: "image-order",
            },
            provenance: {
              kind: "relation" as const,
              sources: [imageRelation],
            },
          }
        : {}),
      validation: { read: null, create: null, update: order },
    },
  ] as const;
