import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { getErrorMessage } from "~/lib/error-utils";
import { imageUpload } from "~/lib/image.functions";

export interface UploadedImage {
  id: string;
  url: string;
  filename: string;
  key: string;
}

/**
 * Standalone `/images` upload transport: validate → presigned PUT → finalize.
 *
 * Extracted from `PendingImageUpload`'s `uploadFile` (`~/app/_components/PendingImageUpload.tsx`),
 * but with the OPPOSITE finalize policy — deliberately NOT layered onto it.
 * `PendingImageUpload`'s rows must stay PENDING until the owning entity's form
 * saves (`associatePendingImages` is what flips them to UPLOADED there). A
 * standalone `/images` upload has no later save step to do that, so it
 * finalizes immediately by calling `image.markUploaded` right after the R2 PUT
 * succeeds. Skipping that call would leave the row PENDING forever — it would
 * render "Upload pending…" indefinitely and then be deleted (R2 object
 * included) by the pending-image cull, which selects exactly PENDING + no
 * entity association (see the `markImageUploaded` doc comment in
 * `~/server/repo/image.ts`).
 *
 * A raw `useMutation` per step (not `useActionMutation`) is correct here —
 * this is the multi-step-file-flow carve-out in root CLAUDE.md: the caller
 * toasts via try/catch around a sequence of `mutateAsync` calls rather than a
 * single mutation's `onSuccess`/`onError`.
 */
export function useImageUpload() {
  const [isUploading, setIsUploading] = useState(false);

  const uploadImageMutation = useMutation(
    imageUpload.uploadImage.mutationOptions(),
  );
  const markUploadedMutation = useMutation(
    imageUpload.markUploaded.mutationOptions(),
  );

  const uploadFile = useCallback(
    async (file: File): Promise<UploadedImage | null> => {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageType)) {
        toast.error(
          `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, HEIC.`,
        );
        return null;
      }
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
        toast.error(`${file.name} exceeds the upload size limit.`);
        return null;
      }

      try {
        const initResult = await uploadImageMutation.mutateAsync({
          filename: file.name,
          contentType: file.type as AllowedImageType,
          size: file.size,
        });

        const uploadResult = await fetch(initResult.uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });
        if (!uploadResult.ok) {
          const errorText = await uploadResult
            .text()
            .catch(() => "Unknown error");
          throw new Error(
            `Storage error (${uploadResult.status}): ${errorText}`,
          );
        }

        await markUploadedMutation.mutateAsync({ id: initResult.imageId });

        return {
          id: initResult.imageId,
          url: initResult.url,
          filename: file.name,
          key: initResult.key,
        };
      } catch (error) {
        toast.error(
          `Upload failed for ${file.name}: ${getErrorMessage(error)}`,
        );
        return null;
      }
    },
    [uploadImageMutation, markUploadedMutation],
  );

  /** Sequential (not `Promise.all`) — bounds presigned-PUT concurrency and
   * keeps any per-file error toasts in selection order. */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<UploadedImage[]> => {
      setIsUploading(true);
      try {
        const uploaded: UploadedImage[] = [];
        for (const file of files) {
          const result = await uploadFile(file);
          if (result) uploaded.push(result);
        }
        return uploaded;
      } finally {
        setIsUploading(false);
      }
    },
    [uploadFile],
  );

  return { uploadFile, uploadFiles, isUploading };
}
