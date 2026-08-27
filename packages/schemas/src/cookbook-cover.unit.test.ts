import { describe, expect, it } from "vitest";
import { cookbookCoverImage } from "./recipe";

describe("cookbookCoverImage", () => {
  it("prefers the cookbook's own cover over the physical copy's", () => {
    expect(
      cookbookCoverImage({
        coverUrl: "https://example.com/own.jpg",
        product: { coverUrl: "https://example.com/shelf.jpg" },
      }),
    ).toBe("https://example.com/own.jpg");
  });

  it("falls back to the physical copy on the shelf", () => {
    // The regression this closes: `product.coverUrl` was resolved server-side
    // for every summary and read by nothing, so these placeholdered.
    expect(
      cookbookCoverImage({
        coverUrl: null,
        product: { coverUrl: "https://example.com/shelf.jpg" },
      }),
    ).toBe("https://example.com/shelf.jpg");
  });

  it("returns null with no cover anywhere", () => {
    expect(cookbookCoverImage({ coverUrl: null, product: null })).toBeNull();
    expect(
      cookbookCoverImage({ coverUrl: null, product: { coverUrl: null } }),
    ).toBeNull();
  });
});
