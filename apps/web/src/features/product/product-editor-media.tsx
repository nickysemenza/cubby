import { imageOut, partitionEntityFiles } from "@cubby/schemas/image";
import { publicImageUrl } from "@cubby/schemas/image-summary";
import { lazy, useMemo, useRef } from "react";
import {
  type FieldValues,
  type UseFormReturn,
  useWatch,
} from "react-hook-form";
import { z } from "zod";

import type {
  EntityEditorMediaInput,
  EntityEditorMediaOutput,
} from "~/entity/editing/editor-presentations";
import { mergeOwnedIds } from "~/entity/editing/shared-id-field";
import type { EntityEditRecord } from "~/entity/editing/types";
import type { PendingImage } from "~/entity/entity-media/pending-image-upload";

const IdentifyProductButton = lazy(() =>
  import("~/features/product/identify-product-with-ai").then((m) => ({
    default: m.IdentifyProductButton,
  })),
);
const PendingDocumentUpload = lazy(() =>
  import("~/entity/entity-media/pending-document-upload").then((m) => ({
    default: m.PendingDocumentUpload,
  })),
);

/** The form port `IdentifyProductButton` accepts — see its own `form` prop. */
interface ProductIdentityFormPort {
  setValue(update: {
    field: "name" | "brandId" | "model";
    value: string;
  }): void;
}

/**
 * `IdentifyProductButton` reads name/brandName/model off the form through
 * a small port, the same shape the retired `product-form-fields.tsx` used.
 */
function productIdentityFormPort(
  form: UseFormReturn<FieldValues>,
): ProductIdentityFormPort {
  return {
    setValue: (update) =>
      form.setValue(update.field, update.value, { shouldDirty: true }),
  };
}

/**
 * The product `media` hook's `actions` slot: a just-removed existing image
 * is client-only until save, so it stays out of the identify read set —
 * otherwise the model would be asked to read a photo the operator is mid-
 * detaching (the regression `IdentifyProductButton`'s own doc comment names).
 */
function ProductIdentifyAction({
  form,
  existingImages,
  pendingImages,
}: {
  form: UseFormReturn<FieldValues>;
  existingImages: readonly PendingImage[];
  pendingImages: readonly PendingImage[];
}) {
  const removedImageIds = z
    .array(z.string())
    .catch([])
    .parse(useWatch({ control: form.control, name: "removeImageIds" }));
  const identifiable = existingImages.filter(
    (image) => !removedImageIds.includes(image.id),
  );
  return (
    <IdentifyProductButton
      form={productIdentityFormPort(form)}
      existingImages={[...identifiable]}
      pendingImages={[...pendingImages]}
    />
  );
}

const attachedImageWithContentType = imageOut.extend({
  purpose: z.enum(["item", "label"]).nullable(),
});
const asPendingImage = (
  image: z.output<typeof attachedImageWithContentType>,
): PendingImage => ({
  id: image.id,
  url: publicImageUrl(image) ?? "",
  filename: image.filename,
  key: image.key,
  ...(image.purpose ? { purpose: image.purpose } : {}),
});

/**
 * The product `media` hook's `documents` slot: manuals share the Product
 * `images` relation with item/label photos, distinguished only by content
 * type (`partitionEntityFiles`) — they can live in either `record.images` or
 * `record.labelImages`. Its uploads/removals write into the shared
 * `pendingImageIds`/`removeImageIds` the image block owns, merging rather
 * than overwriting (`entity-edit-dialog-content.tsx`'s own matching merge on
 * the image side) — each writer tracks and replaces only the slice of the
 * shared array it previously contributed.
 */
function ProductManualsField({
  form,
  record,
}: {
  form: UseFormReturn<FieldValues>;
  record?: EntityEditRecord;
}) {
  // `EntityEditRecord.id` is always a string; no narrowing needed.
  const documentFolder = record?.id;
  const existingDocuments = useMemo(() => {
    const images = z
      .array(attachedImageWithContentType)
      .catch([])
      .parse(record?.images);
    const labelImages = z
      .array(attachedImageWithContentType)
      .catch([])
      .parse(record?.labelImages);
    return partitionEntityFiles([...images, ...labelImages]).documents.map(
      (document) => ({ ...asPendingImage(document), size: undefined }),
    );
  }, [record]);
  const ownPendingDocumentIds = useRef<readonly string[]>([]);
  const ownRemovedDocumentIds = useRef<readonly string[]>([]);
  return (
    <PendingDocumentUpload
      entityKind="PRODUCT"
      folder={documentFolder}
      existingDocuments={existingDocuments}
      onDocumentsChange={(documents) =>
        mergeOwnedIds(
          form,
          "pendingImageIds",
          ownPendingDocumentIds,
          documents.map((document) => document.id),
        )
      }
      onExistingDocumentsRemove={(removedIds) =>
        mergeOwnedIds(form, "removeImageIds", ownRemovedDocumentIds, removedIds)
      }
    />
  );
}

/**
 * Product's `EntityEditorPresentation.media` hook: `IdentifyProductButton`
 * as `actions`, `record.labelImages`' displayable images merged into the
 * gallery as `extraExistingImages`, and the manuals dropzone as `documents`.
 */
export function productMedia({
  form,
  record,
  pendingImages,
  existingImages,
}: EntityEditorMediaInput): EntityEditorMediaOutput {
  const labelImages = z
    .array(attachedImageWithContentType)
    .catch([])
    .parse(record?.labelImages);
  const extraExistingImages =
    partitionEntityFiles(labelImages).images.map(asPendingImage);
  return {
    actions: (
      <ProductIdentifyAction
        form={form}
        existingImages={existingImages}
        pendingImages={pendingImages}
      />
    ),
    extraExistingImages,
    documents: <ProductManualsField form={form} record={record} />,
  };
}
