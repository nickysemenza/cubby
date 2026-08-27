import { describe, expect, it } from "vitest";
import { ingredientCoverImage } from "./ingredient";
import { imageOut, type ImageOut } from "./image";
import { testShortcode } from "./test-support/identifiers";

const img = (overrides: Partial<ImageOut> = {}): ImageOut =>
  imageOut.parse({
    id: testShortcode("image", "IMG-2222"),
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
  });

describe("ingredientCoverImage", () => {
  it("returns null for a stub with no products", () => {
    // The common case by far: ~1,020 of ~1,156 ingredients are stubs, and the
    // column is meant to fall through to the carrot placeholder for them.
    expect(ingredientCoverImage({ product: [] })).toBeNull();
  });

  it("uses the first linked product's photo", () => {
    const photo = img({ id: testShortcode("image", "IMG-3333") });
    const other = img({ id: testShortcode("image", "IMG-4444") });

    expect(
      ingredientCoverImage({
        product: [{ images: [photo] }, { images: [other] }],
      }),
    ).toBe(photo);
  });

  it("skips a product whose only file is a PDF manual", () => {
    // Manuals share the images relation, so an unphotographed product can still
    // arrive with a non-empty `images` — it must not win over a sibling's photo.
    const manual = img({
      id: testShortcode("image", "IMG-5555"),
      filename: "manual.pdf",
      contentType: "application/pdf",
    });
    const photo = img({ id: testShortcode("image", "IMG-6666") });

    expect(
      ingredientCoverImage({
        product: [{ images: [manual] }, { images: [photo] }],
      }),
    ).toBe(photo);
  });

  it("returns null when products exist but none has a displayable image", () => {
    const manual = img({
      id: testShortcode("image", "IMG-7777"),
      filename: "manual.pdf",
      contentType: "application/pdf",
    });
    const failed = img({
      id: testShortcode("image", "IMG-8888"),
      renderStatus: "failed",
    });

    expect(
      ingredientCoverImage({
        product: [{ images: [] }, { images: [manual] }, { images: [failed] }],
      }),
    ).toBeNull();
  });
});
