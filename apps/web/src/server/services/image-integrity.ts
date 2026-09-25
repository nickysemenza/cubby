import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { imageDimensionsFromData } from "image-dimensions";

import { createAppError } from "~/server/errors/app-error";
import { sha256Hex } from "~/server/semantic/hash";

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

const hasBytes = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value);

const asciiAt = (bytes: Uint8Array, start: number, length: number): string =>
  new TextDecoder().decode(bytes.slice(start, start + length));

const isoBaseMediaContentType = (bytes: Uint8Array): string | undefined => {
  if (bytes.length < 12 || asciiAt(bytes, 4, 4) !== "ftyp") return undefined;
  const brand = asciiAt(bytes, 8, 4).toLowerCase();
  if (["heic", "heix", "hevc", "heim", "heis"].includes(brand)) {
    return "image/heic";
  }
  return ["mif1", "msf1"].includes(brand) ? "image/heif" : undefined;
};

const signatureContentType = (bytes: Uint8Array): string | undefined => {
  if (bytes.length >= 8 && hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return "image/png";
  }
  if (bytes.length >= 3 && hasBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  const header = asciiAt(bytes, 0, 6);
  if (bytes.length >= 6 && (header === "GIF87a" || header === "GIF89a")) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    asciiAt(bytes, 0, 4) === "RIFF" &&
    asciiAt(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && asciiAt(bytes, 0, 5) === "%PDF-") {
    return PDF_CONTENT_TYPE;
  }
  return isoBaseMediaContentType(bytes);
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
      sha256: await sha256Hex(bytes),
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
    sha256: await sha256Hex(bytes),
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
