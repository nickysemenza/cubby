import type { ImportRecipe } from "@cubby/schemas/import-recipe";

/** The selected archive images which require an EPUB byte read after persistence. */
export const selectedArchivePhotoIndices = (
  recipes: readonly ImportRecipe[],
  indices: readonly number[],
): number[] =>
  indices.filter((index) => recipes[index]?.image?.kind === "epub");

/** Avoid `String.fromCharCode(...bytes)`, which overflows for ordinary photos. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
};
