import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import { describe, expect, it } from "vitest";

import { bytesToBase64, heroPhoto, selectedPhotoItemIds } from "./photos";

const recipe = (
  id: string,
  photos: { path: string; mime: string }[] = [],
): CookbookRecipe => ({
  kind: "recipe",
  id,
  title: id,
  name: id,
  meta: { description: [], equipment: [] },
  sections: [],
  photos,
  notes: [],
  span: { start: 0, end: 1, doc_path: "text/ch1.xhtml" },
});

describe("cookbook archive photos", () => {
  it("reads only the selected items that carry an archive image", () => {
    const recipesById = new Map<string, CookbookRecipe>([
      ["r1", recipe("r1", [{ path: "images/a.jpg", mime: "image/jpeg" }])],
      ["r2", recipe("r2")],
      ["r3", recipe("r3", [{ path: "images/c.jpg", mime: "image/jpeg" }])],
    ]);

    expect(selectedPhotoItemIds(recipesById, ["r1", "r2"])).toEqual(["r1"]);
    // An id no longer in the tree (a stale selection) is skipped, not thrown on.
    expect(selectedPhotoItemIds(recipesById, ["r3", "gone"])).toEqual(["r3"]);
  });

  it("imports the hero photo, which is the first one", () => {
    const item = recipe("r1", [
      { path: "images/hero.jpg", mime: "image/jpeg" },
      { path: "images/step.jpg", mime: "image/jpeg" },
    ]);
    expect(heroPhoto(item)?.path).toBe("images/hero.jpg");
    expect(heroPhoto(recipe("r2"))).toBeUndefined();
    expect(heroPhoto(undefined)).toBeUndefined();
  });

  it("encodes photo bytes without an argument-limit overflow", () => {
    const bytes = new Uint8Array(0x8001).fill(255);
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
  });
});
