import { describe, expect, it } from "vitest";
import type { ImageOut } from "./image";
import { locationCoverImage } from "./location";

const img = (overrides: Partial<ImageOut> = {}): ImageOut =>
  ({
    id: "img-1",
    url: "https://example.com/photo.jpg",
    key: "photo.jpg",
    filename: "photo.jpg",
    size: 100,
    contentType: "image/jpeg",
    status: "UPLOADED",
    width: null,
    height: null,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    verifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ImageOut;

describe("locationCoverImage", () => {
  it("prefers the location's own photo over the SKU it is", () => {
    const own = img({ id: "own", url: "https://example.com/bin.jpg" });
    const cover = img({ id: "sku", url: "https://example.com/catalog.jpg" });

    expect(
      locationCoverImage({ images: [own], product: { coverImage: cover } }),
    ).toBe(own);
  });

  it("falls back to the SKU's cover when the bin has no photo of its own", () => {
    const cover = img({ id: "sku" });

    expect(
      locationCoverImage({ images: [], product: { coverImage: cover } }),
    ).toBe(cover);
  });

  it("skips an undisplayable own image rather than treating it as a photo", () => {
    // A PDF manual in the location gallery is not a picture of the bin; it must
    // fall through, not win and render broken.
    const manual = img({ id: "pdf", contentType: "application/pdf" });
    const cover = img({ id: "sku" });

    expect(
      locationCoverImage({ images: [manual], product: { coverImage: cover } }),
    ).toBe(cover);
  });

  it("skips a failed-render own image", () => {
    const broken = img({ id: "broken", renderStatus: "failed" });
    const cover = img({ id: "sku" });

    expect(
      locationCoverImage({ images: [broken], product: { coverImage: cover } }),
    ).toBe(cover);
  });

  it("returns null rather than an undisplayable SKU cover", () => {
    const manual = img({ id: "pdf", contentType: "application/pdf" });

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
