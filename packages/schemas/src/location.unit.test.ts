import { imageOut, type ImageOut } from "./image";
import { testShortcode } from "./test-support/identifiers";
import { locationCoverImage } from "./location";
import { describe, expect, it } from "vitest";

const img = (overrides: Partial<ImageOut> = {}): ImageOut =>
  imageOut.parse({
    id: testShortcode("image", "IMG-2222"),
    url: "https://example.com/photo.jpg",
    key: "photo.jpg",
    filename: "photo.jpg",
    size: 100,
    contentType: "image/jpeg",
    status: "UPLOADED",
    useOriginal: false,
    width: null,
    height: null,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    source: "unknown",
    sourcePageUrl: null,
    sourceAssetUrl: null,
    sourceName: null,
    verifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

describe("locationCoverImage", () => {
  it("prefers the location's own photo over the SKU it is", () => {
    const own = img({
      id: testShortcode("image", "IMG-3333"),
      url: "https://example.com/bin.jpg",
    });
    const cover = img({
      id: testShortcode("image", "IMG-4444"),
      url: "https://example.com/catalog.jpg",
    });

    expect(
      locationCoverImage({ images: [own], product: { coverImage: cover } }),
    ).toBe(own);
  });

  it("falls back to the SKU's cover when the bin has no photo of its own", () => {
    const cover = img({ id: testShortcode("image", "IMG-7777") });

    expect(
      locationCoverImage({ images: [], product: { coverImage: cover } }),
    ).toBe(cover);
  });

  it("skips an undisplayable own image rather than treating it as a photo", () => {
    // A PDF manual in the location gallery is not a picture of the bin; it must
    // fall through, not win and render broken.
    const manual = img({
      id: testShortcode("image", "IMG-5555"),
      contentType: "application/pdf",
    });
    const cover = img({ id: testShortcode("image", "IMG-8888") });

    expect(
      locationCoverImage({ images: [manual], product: { coverImage: cover } }),
    ).toBe(cover);
  });

  it("skips a failed-render own image", () => {
    const broken = img({
      id: testShortcode("image", "IMG-6666"),
      renderStatus: "failed",
    });
    const cover = img({ id: testShortcode("image", "IMG-9999") });

    expect(
      locationCoverImage({ images: [broken], product: { coverImage: cover } }),
    ).toBe(cover);
  });

  it("returns null rather than an undisplayable SKU cover", () => {
    const manual = img({
      id: testShortcode("image", "IMG-7777"),
      contentType: "application/pdf",
    });

    expect(
      locationCoverImage({ images: [], product: { coverImage: manual } }),
    ).toBeNull();
  });

  it("returns null when there is nothing to show", () => {
    expect(locationCoverImage({ images: [], product: null })).toBeNull();
    expect(
      locationCoverImage({ images: [], product: { coverImage: null } }),
    ).toBeNull();
  });
});
