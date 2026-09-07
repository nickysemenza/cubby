import { describe, expect, it } from "vitest";
import { importRecipeSchema } from "./import-recipe";

const recipe = { meta: { title: "Roast carrots" }, sections: [] };

describe("recipe image source ingress", () => {
  it("normalizes persisted public URLs and upstream archive references", () => {
    expect(
      importRecipeSchema.parse({
        ...recipe,
        image: "https://example.com/carrot.jpg",
      }).image,
    ).toEqual({ kind: "url", url: "https://example.com/carrot.jpg" });
    expect(
      importRecipeSchema.parse({
        ...recipe,
        image: { path: "Images/carrot.jpg", mime: "image/jpeg" },
      }).image,
    ).toEqual({ kind: "epub", path: "Images/carrot.jpg", mime: "image/jpeg" });
  });
  it("round trips normalized images without changing provenance", () => {
    const parsed = importRecipeSchema.parse({
      ...recipe,
      image: {
        kind: "epub",
        path: "Images/carrot.jpg",
        mime: "image/jpeg",
        alt: "Carrots",
      },
    });
    expect(importRecipeSchema.parse(parsed)).toEqual(parsed);
  });
  it("does not accept an archive path as a public URL", () => {
    expect(
      importRecipeSchema.safeParse({ ...recipe, image: "Images/carrot.jpg" })
        .success,
    ).toBe(false);
    expect(
      importRecipeSchema.safeParse({
        ...recipe,
        image: { kind: "url", url: "Images/carrot.jpg" },
      }).success,
    ).toBe(false);
  });
});
