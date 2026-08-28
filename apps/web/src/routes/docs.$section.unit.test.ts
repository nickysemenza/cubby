import { describe, expect, it } from "vitest";

import { loadDocsSection } from "./docs.$section";

describe("documentation section route", () => {
  it("turns unknown document slugs into route not-found recovery", () => {
    expect(() =>
      loadDocsSection({ params: { section: "not-a-document" } }),
    ).toThrow(expect.objectContaining({ isNotFound: true }));
  });
});
