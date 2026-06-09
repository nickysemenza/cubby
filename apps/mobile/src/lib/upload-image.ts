import { unsafeProductId } from "@cubby/schemas/identifiers";
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
 * The PUT uses the global `fetch` deliberately: the presigned URL is self-authed,
 * so the tRPC client's Cookie/x-trpc headers must NOT ride along (they'd break
 * the signature). R2 CORS is irrelevant on native (RN fetch isn't a browser).
 */
export async function uploadAndAttachToProduct(
  client: TRPCClient,
  productId: string,
  asset: ImagePickerAsset,
): Promise<void> {
  const blob = await (await fetch(asset.uri)).blob();
  const contentType = toContentType(asset.mimeType);
  const filename = asset.fileName ?? `photo-${Date.now()}.jpg`;

  const { uploadUrl, imageId } = await client.image.uploadImage.mutate({
    filename,
    contentType,
    size: blob.size,
    entityType: "PRODUCT",
  });

  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": contentType },
  });
  if (!put.ok) {
    throw new Error(`Storage upload failed (${put.status})`);
  }

  await client.product.update.mutate({
    id: unsafeProductId(productId),
    data: { pendingImageIds: [imageId] },
  });
}
