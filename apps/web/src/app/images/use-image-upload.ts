import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { showErrorToast } from "~/components/feedback/error-details";
import { imageUpload } from "~/lib/image.functions";

export interface UploadedImage {
  id: string;
  url: string;
  filename: string;
  key: string;
}

export type ImageUploadResult =
  | { state: "complete"; image: UploadedImage }
  | { state: "failed"; uploadedImage?: UploadedImage }
  | { state: "in-flight" };

const imageContentTypeSchema = z.enum(ALLOWED_IMAGE_TYPES);

type ImageUploadOperations = Pick<
  typeof imageUpload,
  "uploadImage" | "markUploaded"
>;

/**
 * Standalone `/images` upload transport: validate → presigned PUT → finalize.
 *
 * Unlike `PendingImageUpload`, no owning form will later associate this row,
 * so a successful PUT must be finalized here instead of being left PENDING.
 * A completed PUT is checkpointed in the caller's draft before `markUploaded`.
 * If that final step fails, retry only finalizes the same image row: it never
 * creates another pending row or uploads the bytes again.
 */
export function useImageUpload(
  operations: ImageUploadOperations = imageUpload,
) {
  const [activeUploadCount, setActiveUploadCount] = useState(0);
  const inFlightFilesRef = useRef(new WeakSet<File>());

  const uploadImageMutation = useMutation(
    operations.uploadImage.mutationOptions({
      // No toast here: `uploadFile`'s catch below already turns any failure
      // in this flow into one `showErrorToast`; a populated `onError` would
      // additionally trigger the global toast.
      onError: () => {},
    }),
  );
  const markUploadedMutation = useMutation(
    operations.markUploaded.mutationOptions({
      onError: () => {},
    }),
  );

  const uploadFile = useCallback(
    async (
      file: File,
      checkpoint?: UploadedImage,
    ): Promise<ImageUploadResult> => {
      if (inFlightFilesRef.current.has(file)) return { state: "in-flight" };

      const contentType = imageContentTypeSchema.safeParse(file.type);
      if (!checkpoint && !contentType.success) {
        toast.error(
          `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, HEIC.`,
        );
        return { state: "failed" };
      }
      if (!checkpoint && file.size > MAX_IMAGE_UPLOAD_BYTES) {
        toast.error(`${file.name} exceeds the upload size limit.`);
        return { state: "failed" };
      }

      inFlightFilesRef.current.add(file);
      setActiveUploadCount((count) => count + 1);
      let uploadedImage = checkpoint;
      try {
        if (!uploadedImage) {
          // `contentType` has succeeded above when there is no checkpoint.
          const initResult = await uploadImageMutation.mutateAsync({
            filename: file.name,
            contentType: contentType.data!,
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

          uploadedImage = {
            id: initResult.imageId,
            url: initResult.url,
            filename: file.name,
            key: initResult.key,
          };
        }

        await markUploadedMutation.mutateAsync({ id: uploadedImage.id });
        return { state: "complete", image: uploadedImage };
      } catch (error) {
        showErrorToast(error, `Upload failed for ${file.name}`);
        return { state: "failed", uploadedImage };
      } finally {
        inFlightFilesRef.current.delete(file);
        setActiveUploadCount((count) => Math.max(0, count - 1));
      }
    },
    [markUploadedMutation, uploadImageMutation],
  );

  /** Sequential (not `Promise.all`) — bounds presigned-PUT concurrency and
   * keeps any per-file error toasts in selection order. */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<UploadedImage[]> => {
      const uploaded: UploadedImage[] = [];
      for (const file of files) {
        const result = await uploadFile(file);
        if (result.state === "complete") uploaded.push(result.image);
      }
      return uploaded;
    },
    [uploadFile],
  );

  return {
    uploadFile,
    uploadFiles,
    isUploading: activeUploadCount > 0,
  };
}
