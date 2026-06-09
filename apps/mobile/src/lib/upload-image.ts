import { unsafeProductId } from "@cubby/schemas/identifiers";
import * as FileSystem from "expo-file-system/legacy";
import type { ImagePickerAsset } from "expo-image-picker";
import type { useTRPCClient } from "./trpc";

type TRPCClient = ReturnType<typeof useTRPCClient>;

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

/**
 * Upload a picked/captured image to R2 and attach it to a product — mirrors the
 * web flow (apps/web/.../PendingImageUpload.tsx): presigned PUT → bytes → attach.
 *
 * RN can't PUT a Blob built from a file URI ("Creating blobs from ArrayBuffer
 * ... not supported"), so we stream the file with expo-file-system `uploadAsync`
 * (BINARY_CONTENT = raw body). The presigned URL is self-authed, so no
 * Cookie/x-trpc headers (they'd break the signature). R2 CORS is irrelevant on
 * native (uploadAsync isn't a browser request).
 */
export async function uploadAndAttachToProduct(
  client: TRPCClient,
  productId: string,
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
    entityType: "PRODUCT",
  });

  const res = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": contentType },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Storage upload failed (${res.status})`);
  }

  await client.product.update.mutate({
    id: unsafeProductId(productId),
    data: { pendingImageIds: [imageId] },
  });
}
