import { describe, expect, it } from "vitest";
import { transformedImageUrl, transformedSrcSet } from "./image-url";

const BUCKET = "https://foobucket.nicky.fun";

describe("transformedImageUrl", () => {
  it("rewrites a bucket URL through /cdn-cgi/image with the given width", () => {
    expect(transformedImageUrl(`${BUCKET}/cubby/images/a.jpg`, 400)).toBe(
      `${BUCKET}/cdn-cgi/image/width=400,quality=80,format=auto,fit=scale-down/cubby/images/a.jpg`,
    );
  });

  it("preserves the query string", () => {
    expect(transformedImageUrl(`${BUCKET}/cubby/x.jpg?v=2`, 64)).toBe(
      `${BUCKET}/cdn-cgi/image/width=64,quality=80,format=auto,fit=scale-down/cubby/x.jpg?v=2`,
    );
  });

  it("passes through URLs not on the bucket host", () => {
    const other = "https://images.example.com/cubby/a.jpg";
    expect(transformedImageUrl(other, 400)).toBe(other);
  });

  it("passes through already-transformed URLs (no double-wrap)", () => {
    const already = `${BUCKET}/cdn-cgi/image/width=100,format=auto/cubby/a.jpg`;
    expect(transformedImageUrl(already, 400)).toBe(already);
  });

  it("passes through strings that don't parse as a URL", () => {
    expect(transformedImageUrl("not a url", 400)).toBe("not a url");
    expect(transformedImageUrl("", 400)).toBe("");
  });
});

describe("transformedSrcSet", () => {
  it("emits 1x and 2x variants for a bucket URL", () => {
    const src = `${BUCKET}/cubby/images/a.jpg`;
    expect(transformedSrcSet(src, 400)).toBe(
      `${transformedImageUrl(src, 400)} 1x, ${transformedImageUrl(src, 800)} 2x`,
    );
  });

  it("returns undefined for non-transformable URLs", () => {
    expect(transformedSrcSet("https://example.com/a.jpg", 400)).toBeUndefined();
    expect(transformedSrcSet("not a url", 400)).toBeUndefined();
  });
});
