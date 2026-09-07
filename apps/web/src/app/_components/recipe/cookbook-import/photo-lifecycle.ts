import type { ImportResult, PhotoResult } from "./types";

export const shouldPreparePhoto = (result: PhotoResult | undefined): boolean =>
  result === undefined;

export const resetReextractedBook = (hasCookbook: boolean) => ({
  results: new Map<number, ImportResult>(),
  photos: new Map<number, PhotoResult>(),
  photoPreviewUrls: new Map<number, string>(),
  importProgress: undefined,
  photoProgress: undefined,
  needsCookbookUpsert: hasCookbook,
});

export const discardBookPhotoResources = (
  archiveBytesBySource: Map<string, Map<string, Uint8Array>>,
  previewUrlsBySource: Map<string, Map<number, string>>,
  source: string,
  revoke: (url: string) => void,
) => {
  archiveBytesBySource.delete(source);
  const previews = previewUrlsBySource.get(source);
  previews?.forEach(revoke);
  previewUrlsBySource.delete(source);
};
