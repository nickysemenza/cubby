import type { ImportResult, PhotoResult } from "./types";

/**
 * Only an untouched recipe gets its photo (re-)prepared. A failure must keep
 * its Retry action, and an attached photo is terminal even if the selection
 * changes later in the review.
 */
export const shouldPreparePhoto = (result: PhotoResult | undefined): boolean =>
  result === undefined;

/**
 * The per-recipe state a re-extraction invalidates.
 *
 * Item ids are stable across re-extractions of the same EPUB, so results and
 * photos would *mostly* still line up — but "mostly" is the wrong standard for
 * something that attaches photos to recipes. A re-extraction can also drop or
 * split an item, and the tree it produces is not the one the cookbook row
 * holds, so the book is marked as needing a fresh upsert before any
 * id-addressed import can run again.
 */
export const resetReextractedBook = (hasCookbook: boolean) => ({
  results: new Map<string, ImportResult>(),
  photos: new Map<string, PhotoResult>(),
  photoPreviewUrls: new Map<string, string>(),
  importProgress: undefined,
  photoProgress: undefined,
  needsCookbookUpsert: hasCookbook,
});

/** Release every object URL and cached archive read belonging to one book. */
export const discardBookPhotoResources = (
  archiveBytesBySource: Map<string, Map<string, Uint8Array>>,
  previewUrlsBySource: Map<string, Map<string, string>>,
  source: string,
  revoke: (url: string) => void,
) => {
  archiveBytesBySource.delete(source);
  const previews = previewUrlsBySource.get(source);
  previews?.forEach(revoke);
  previewUrlsBySource.delete(source);
};
