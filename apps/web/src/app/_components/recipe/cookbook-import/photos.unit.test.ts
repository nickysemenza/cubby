import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { describe, expect, it } from "vitest";

import { bytesToBase64, selectedArchivePhotoIndices } from "./photos";

const recipe = (image?: ImportRecipe["image"]): ImportRecipe => ({
  meta: { title: "Recipe" },
  sections: [],
  references: [],
  image,
});

describe("cookbook archive photos", () => {
  it("reads only selected EPUB archive images", () => {
    expect(
      selectedArchivePhotoIndices(
        [
          recipe({ kind: "epub", path: "images/a.jpg", mime: "image/jpeg" }),
          recipe({ kind: "url", url: "https://example.com/b.jpg" }),
          recipe(),
          recipe({ kind: "epub", path: "images/d.jpg", mime: "image/jpeg" }),
        ],
        [0, 1, 2],
      ),
    ).toEqual([0]);
  });

  it("encodes photo bytes without an argument-limit overflow", () => {
    const bytes = new Uint8Array(0x8001).fill(255);
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
  });
});
