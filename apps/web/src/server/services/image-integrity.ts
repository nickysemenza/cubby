import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { imageDimensionsFromData } from "image-dimensions";

import { createAppError } from "~/server/errors/app-error";

const dimensionMimeType = (dimensionType: string): string | undefined => {
  switch (dimensionType) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return undefined;
  }
};

const signatureContentType = (bytes: Uint8Array): string | undefined => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a"
  )
    return "image/gif";
  if (
    bytes.length >= 6 &&
    new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a"
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 5 &&
    new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-"
  )
    return PDF_CONTENT_TYPE;
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp"
  ) {
    const brand = new TextDecoder().decode(bytes.slice(8, 12)).toLowerCase();
    if (["heic", "heix", "hevc", "heim", "heis"].includes(brand))
      return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  return undefined;
};

export type InspectedImageFile = {
  contentType: string;
  width: number | null;
  height: number | null;
  detectedContentType: string;
  sha256: string;
  renderStatus: "verified" | "failed";
  storageStatus: "available";
  verifiedAt: Date;
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const inspectImageFile = async (
  bytes: Uint8Array,
  declaredContentType: string,
): Promise<InspectedImageFile> => {
  const contentType = declaredContentType
    .toLowerCase()
    .split(";", 1)[0]!
    .trim();
  const signature = signatureContentType(bytes);
  if (!signature)
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "File bytes do not match a supported image or PDF format",
    );
  const compatible =
    signature === contentType ||
    ((signature === "image/heic" || signature === "image/heif") &&
      (contentType === "image/heic" || contentType === "image/heif"));
  if (!compatible)
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `Declared content type ${contentType} conflicts with file bytes (${signature})`,
    );
  if (signature === PDF_CONTENT_TYPE) {
    return {
      contentType,
      width: null,
      height: null,
      detectedContentType: signature,
      sha256: await sha256(bytes),
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    };
  }
  const dimensions = imageDimensionsFromData(bytes);
  const detectedContentType = dimensions
    ? (dimensionMimeType(dimensions.type) ?? signature)
    : signature;
  if (!dimensions)
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "Image dimensions could not be read",
    );
  return {
    contentType,
    width: dimensions.width,
    height: dimensions.height,
    detectedContentType,
    sha256: await sha256(bytes),
    renderStatus: "verified",
    storageStatus: "available",
    verifiedAt: new Date(),
  };
};

export const filenameForContentType = (
  filename: string,
  contentType: string,
): string => {
  const extension =
    contentType === PDF_CONTENT_TYPE
      ? "pdf"
      : contentType === "image/jpeg"
        ? "jpg"
        : (contentType.split("/")[1] ?? "bin");
  const base = filename.trim().replace(/\.[^.]*$/, "") || "attachment";
  return `${base}.${extension}`;
};
