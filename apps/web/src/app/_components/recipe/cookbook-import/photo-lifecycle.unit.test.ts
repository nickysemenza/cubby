import { describe, expect, it, vi } from "vitest";

import {
  discardBookPhotoResources,
  resetReextractedBook,
  shouldPreparePhoto,
} from "./photo-lifecycle";

describe("cookbook photo lifecycle", () => {
  it("preserves failed and successful outcomes when an EPUB is reconnected", () => {
    expect(shouldPreparePhoto(undefined)).toBe(true);
    expect(
      shouldPreparePhoto({ status: "missing-bytes", message: "Choose EPUB" }),
    ).toBe(false);
    expect(shouldPreparePhoto({ status: "attached" })).toBe(false);
  });

  it("releases every preview and archive cache entry when its book is replaced or removed", () => {
    const archiveBytes = new Map([
      ["book.epub", new Map([["images/hero.jpg", new Uint8Array([1])]])],
    ]);
    const previews = new Map([
      [
        "book.epub",
        new Map([
          ["003.0012", "blob:hero"],
          ["004.0044", "blob:detail"],
        ]),
      ],
    ]);
    const revoke = vi.fn();

    discardBookPhotoResources(archiveBytes, previews, "book.epub", revoke);

    expect(revoke).toHaveBeenCalledTimes(2);
    expect(archiveBytes.has("book.epub")).toBe(false);
    expect(previews.has("book.epub")).toBe(false);
  });

  it("makes a refreshed extraction persist its new tree before id-addressed import", () => {
    const state = resetReextractedBook(true);

    expect(state.needsCookbookUpsert).toBe(true);
    expect(state.results.size).toBe(0);
    expect(state.photos.size).toBe(0);
    expect(state.photoPreviewUrls.size).toBe(0);
    expect(state.importProgress).toBeUndefined();
    expect(state.photoProgress).toBeUndefined();
  });
});
