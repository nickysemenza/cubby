import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { UpdateInputImages } from "@cubby/schemas/image";
import { useState } from "react";

import type { PendingImage } from "~/app/_components/PendingImageUpload";

export function useImageState() {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [removedImageIds, setRemovedImageIds] = useState<string[]>([]);
  const [existingImagePurposes, setExistingImagePurposes] = useState<
    Record<string, "item" | "label">
  >({});
  // Documents (PDF manuals) ride the same pendingImageIds/removeImageIds
  // plumbing but are tracked separately so the image UI (cover, reorder)
  // never sees them.
  const [pendingDocuments, setPendingDocuments] = useState<PendingImage[]>([]);
  const [removedDocumentIds, setRemovedDocumentIds] = useState<string[]>([]);

  const handlePendingImagesChange = (images: PendingImage[]) => {
    setPendingImages(images);
  };

  const handleRemovedImagesChange = (ids: string[]) => {
    setRemovedImageIds(ids);
  };

  const handleExistingImagePurposesChange = (
    purposes: Record<string, "item" | "label">,
  ) => {
    setExistingImagePurposes(purposes);
  };

  const handlePendingDocumentsChange = (documents: PendingImage[]) => {
    setPendingDocuments(documents);
  };

  const handleRemovedDocumentsChange = (ids: string[]) => {
    setRemovedDocumentIds(ids);
  };

  const getImageData = (isCreate = false): Partial<UpdateInputImages> => {
    const imageData: Partial<UpdateInputImages> = {};

    // Pending documents merge into pendingImageIds — same association path.
    // `PendingImage.id` is plain `string` (the same gallery component also
    // handles existing images), but the value underneath is always the
    // `IMG-` shortcode `create_file_uploads`/`image.uploadImage` hand back —
    // parsed at this shared gallery boundary before the update input is built.
    // A Product role correction deliberately reuses pendingImageIds: the
    // product repository accepts an already-active attachment and applies its
    // explicit pendingImagePurposes value without detaching or reordering it.
    const pendingIds = [
      ...pendingImages.map((image) => image.id),
      ...pendingDocuments.map((document) => document.id),
      ...Object.keys(existingImagePurposes),
    ];
    if (pendingIds.length > 0) {
      imageData.pendingImageIds = pendingIds.map((id) =>
        parseShortcodeFor("image", id),
      );
    }

    // `removedImageIds` names EXISTING images — ids that came back from the
    // server as `ImageOut.id`, i.e. real `IMG-` shortcodes — the same
    // shortcode shape as `pendingIds` above, asserted here because the
    // callback prop that feeds this state (`onExistingImagesRemove`) is typed
    // as plain `string[]` since the same gallery component also handles
    // pending images. Reordering existing images is the generic edit
    // dialog's affordance (`imageOrder`), not a full-page form's.
    const removedIds = [...removedImageIds, ...removedDocumentIds];
    if (!isCreate && removedIds.length > 0) {
      imageData.removeImageIds = removedIds.map((id) =>
        parseShortcodeFor("image", id),
      );
    }

    return imageData;
  };

  /** Product is the sole gallery whose pending attachments have roles. */
  const getPendingImagePurposes = (): Record<string, "item" | "label"> =>
    Object.assign(
      {},
      existingImagePurposes,
      Object.fromEntries(
        pendingImages.flatMap((image) =>
          image.purpose ? [[image.id, image.purpose] as const] : [],
        ),
      ),
    );

  const hasImageChanges = (): boolean => {
    return (
      pendingImages.length > 0 ||
      removedImageIds.length > 0 ||
      Object.keys(existingImagePurposes).length > 0 ||
      pendingDocuments.length > 0 ||
      removedDocumentIds.length > 0
    );
  };

  const reset = () => {
    setPendingImages([]);
    setRemovedImageIds([]);
    setExistingImagePurposes({});
    setPendingDocuments([]);
    setRemovedDocumentIds([]);
  };

  return {
    pendingImages,
    removedImageIds,
    handlePendingImagesChange,
    handleRemovedImagesChange,
    handleExistingImagePurposesChange,
    handlePendingDocumentsChange,
    handleRemovedDocumentsChange,
    getImageData,
    getPendingImagePurposes,
    hasImageChanges,
    reset,
  };
}
