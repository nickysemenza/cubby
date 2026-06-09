import {
  unsafeLocationId,
  unsafeProductId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import * as FileSystem from "expo-file-system/legacy";
import type { ImagePickerAsset } from "expo-image-picker";
import type { useTRPCClient } from "./trpc";

type TRPCClient = ReturnType<typeof useTRPCClient>;

/** Entities that own images (matches the server `entityImage` enum subset we use). */
export type ImageEntityType = "PRODUCT" | "LOCATION" | "RECIPE";

type ImageUpdate = { pendingImageIds?: string[]; removeImageIds?: string[] };

// Mirrors imageContentType (packages/schemas/src/image.ts).
type ImageContentType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/heic"
  | "image/heif";

const ALLOWED: readonly ImageContentType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
];

function toContentType(mime: string | null | undefined): ImageContentType {
  return mime && (ALLOWED as readonly string[]).includes(mime)
    ? (mime as ImageContentType)
    : "image/jpeg";
}

/** Attach/remove images on a product/location/recipe via its `update` procedure. */
function updateEntityImages(
  client: TRPCClient,
  entityType: ImageEntityType,
  entityId: string,
  data: ImageUpdate,
) {
  switch (entityType) {
    case "PRODUCT":
      return client.product.update.mutate({
        id: unsafeProductId(entityId),
        data,
      });
    case "LOCATION":
      return client.location.update.mutate({
        id: unsafeLocationId(entityId),
        data,
      });
    case "RECIPE":
      return client.recipe.update.mutate({
        id: unsafeRecipeId(entityId),
        data,
      });
  }
}

/**
 * Upload a picked/captured image to R2 and attach it to an entity — mirrors the
 * web flow (apps/web/.../PendingImageUpload.tsx): presigned PUT → bytes → attach.
 *
 * RN can't PUT a Blob built from a file URI, so we stream the file with
 * expo-file-system `uploadAsync` (BINARY_CONTENT = raw body). The presigned URL
 * is self-authed, so no Cookie/x-trpc headers (they'd break the signature); R2
 * CORS is irrelevant on native.
 */
export async function uploadAndAttach(
  client: TRPCClient,
  entityType: ImageEntityType,
  entityId: string,
  asset: ImagePickerAsset,
): Promise<void> {
  const contentType = toContentType(asset.mimeType);
  const filename = asset.fileName ?? `photo-${Date.now()}.jpg`;
  const info = await FileSystem.getInfoAsync(asset.uri);
  const size = asset.fileSize ?? (info.exists ? info.size : 0);
  if (!size) throw new Error("Could not read the selected image");

  const { uploadUrl, imageId } = await client.image.uploadImage.mutate({
    filename,
    contentType,
    size,
    entityType,
  });

  const res = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": contentType },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Storage upload failed (${res.status})`);
  }

  await updateEntityImages(client, entityType, entityId, {
    pendingImageIds: [imageId],
  });
}

/** Detach an image from an entity (soft-removes the join, keeps the image row). */
export function removeEntityImage(
  client: TRPCClient,
  entityType: ImageEntityType,
  entityId: string,
  imageId: string,
): Promise<unknown> {
  return updateEntityImages(client, entityType, entityId, {
    removeImageIds: [imageId],
  });
}
