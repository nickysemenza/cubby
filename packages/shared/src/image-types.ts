export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

const ALLOWED_IMAGE_TYPE_SET: ReadonlySet<string> = new Set(
  ALLOWED_IMAGE_TYPES,
);

export const isAllowedImageType = (
  contentType: string,
): contentType is AllowedImageType => ALLOWED_IMAGE_TYPE_SET.has(contentType);
