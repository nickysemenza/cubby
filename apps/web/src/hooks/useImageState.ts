import type { UpdateInputImages } from "@cubby/schemas/image";
import { useState } from "react";
import type { PendingImage } from "~/app/_components/PendingImageUpload";

/**
 * Custom hook for managing image state in forms (both pending uploads and removed images).
 *
 * Returns:
 * - pendingImages: Array of pending images
 * - removedImageIds: Array of IDs for images to be removed
 * - handlePendingImagesChange: Callback for PendingImageUpload's onImagesChange
 * - handleRemovedImagesChange: Callback for PendingImageUpload's onExistingImagesRemove
 * - getImageData: Helper function that returns the image data in the format required by the API
 */
export function useImageState() {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [removedImageIds, setRemovedImageIds] = useState<string[]>([]);
  // null = untouched; an array is the full display order of the existing
  // images (first = cover) after the user reordered them.
  const [imageOrder, setImageOrder] = useState<string[] | null>(null);

  const handlePendingImagesChange = (images: PendingImage[]) => {
    setPendingImages(images);
  };

  const handleRemovedImagesChange = (ids: string[]) => {
    setRemovedImageIds(ids);
  };

  const handleExistingImagesReorder = (orderedIds: string[]) => {
    setImageOrder(orderedIds);
  };

  /**
   * Returns the image data in the format required by the API.
   * For create operations, pass isCreate=true and it will only include pendingImageIds.
   */
  const getImageData = (isCreate = false): Partial<UpdateInputImages> => {
    const imageData: Partial<UpdateInputImages> = {};

    // If we have pending images, include them in the data
    if (pendingImages.length > 0) {
      imageData.pendingImageIds = pendingImages.map((img) => img.id);
    }

    // If we have removed images and this is not a create operation, include them
    if (!isCreate && removedImageIds.length > 0) {
      imageData.removeImageIds = removedImageIds;
    }

    // If the user reordered the existing images, persist the new order.
    // Removed ids may still appear here; the server applies order before the
    // removal, so they are harmless.
    if (!isCreate && imageOrder !== null) {
      imageData.imageOrder = imageOrder;
    }

    return imageData;
  };

  /**
   * Check if there are any image changes
   */
  const hasImageChanges = (): boolean => {
    return (
      pendingImages.length > 0 ||
      removedImageIds.length > 0 ||
      imageOrder !== null
    );
  };

  /**
   * Reset all image state (pending uploads, removed IDs, reorder).
   * Useful when switching form modes or cancelling.
   */
  const reset = () => {
    setPendingImages([]);
    setRemovedImageIds([]);
    setImageOrder(null);
  };

  return {
    pendingImages,
    removedImageIds,
    handlePendingImagesChange,
    handleRemovedImagesChange,
    handleExistingImagesReorder,
    getImageData,
    hasImageChanges,
    reset,
  };
}
