import type { ImageOut } from "@cubby/schemas/image";
import { imageOut } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import { flattenPhotoStops, needsPhoto } from "./photo-pass-utils";

function img(overrides: Partial<ImageOut> = {}): ImageOut {
  return imageOut.parse({
    id: testShortcode("image", "IMG-A001"),
    url: "https://example.test/a.jpg",
    key: "images/a.jpg",
    filename: "a.jpg",
    size: 1024,
    contentType: "image/jpeg",
    status: "UPLOADED",
    useOriginal: false,
    width: 800,
    height: 600,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    verifiedAt: null,
    source: "unknown",
    sourcePageUrl: null,
    sourceAssetUrl: null,
    sourceName: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
}

function loc(
  code: string,
  name: string,
  type: LocationType | null,
  extra: {
    images?: ImageOut[];
    children?: InfLocation[];
    product?: InfLocation["product"];
  } = {},
): InfLocation {
  return {
    id: testShortcode("location", `LOC-${code}`),
    name,
    aliases: [],
    product: extra.product ?? null,
    type,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: extra.images ?? [],
    valuation: null,
    dataQuality: testCompleteDataQuality(),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    children: extra.children ?? [],
  };
}

describe("needsPhoto", () => {
  it("is false once a displayable image is attached", () => {
    expect(needsPhoto({ images: [img()] })).toBe(false);
  });

  it("is true for no images at all", () => {
    expect(needsPhoto({ images: [] })).toBe(true);
    expect(needsPhoto({})).toBe(true);
  });

  // The list's imagePresenceFilter joins through displayableImageWhere, so a
  // PDF-only or failed-render location reads "(none)" there. The queue has to
  // agree or the backlog count and the queue length diverge.
  it("is true when the only attachment is a PDF", () => {
    expect(
      needsPhoto({ images: [img({ contentType: "application/pdf" })] }),
    ).toBe(true);
  });

  it("is true when the only image failed to render", () => {
    expect(needsPhoto({ images: [img({ renderStatus: "failed" })] })).toBe(
      true,
    );
  });

  it("is true when the only image is missing from storage", () => {
    expect(needsPhoto({ images: [img({ storageStatus: "missing" })] })).toBe(
      true,
    );
  });

  it("ignores an unusable image when a usable one is also attached", () => {
    expect(
      needsPhoto({ images: [img({ renderStatus: "failed" }), img()] }),
    ).toBe(false);
  });

  it("still requires a true location photo when a linked product has a cover", () => {
    const productBacked = loc("AAAA", "Drawer box", null, {
      product: {
        id: testShortcode("product", "PRD-AAAA"),
        name: "Two drawer box",
        manufacturer: "Example",
        model: null,
        category: categorySummaryFixture("storage"),
        coverImage: img(),
        price: null,
      },
    });

    expect(needsPhoto(productBacked)).toBe(true);
  });
});

describe("flattenPhotoStops", () => {
  const tree = [
    loc("AAAA", "Garage", "room", {
      children: [
        loc("BBBB", "Shelf 1", "shelf", {
          images: [img()],
          children: [loc("CCCC", "Bin A", "box")],
        }),
        loc("DDDD", "Shelf 2", "shelf"),
      ],
    }),
  ];

  it("walks depth-first and defaults to locations needing a photo", () => {
    const stops = flattenPhotoStops(tree);
    expect(stops.map((s) => s.name)).toEqual(["Garage", "Bin A", "Shelf 2"]);
  });

  it("recurses through a filtered-out parent", () => {
    // Shelf 1 already has a photo and is excluded, but Bin A beneath it is not.
    const stops = flattenPhotoStops(tree);
    expect(stops.map((s) => s.name)).toContain("Bin A");
  });

  it("includes photographed locations when asked", () => {
    const stops = flattenPhotoStops(tree, { includePhotographed: true });
    expect(stops.map((s) => s.name)).toEqual([
      "Garage",
      "Shelf 1",
      "Bin A",
      "Shelf 2",
    ]);
  });

  it("narrows by type without hiding nested matches", () => {
    const stops = flattenPhotoStops(tree, { types: ["box"] });
    expect(stops.map((s) => s.name)).toEqual(["Bin A"]);
  });

  it("treats an empty type list as unrestricted", () => {
    expect(flattenPhotoStops(tree, { types: [] })).toHaveLength(3);
  });

  it("carries the path and depth from the scoped root", () => {
    const stops = flattenPhotoStops(tree, { includePhotographed: true });
    const bin = stops.find((s) => s.name === "Bin A");
    expect(bin?.path).toEqual(["Garage", "Shelf 1", "Bin A"]);
    expect(bin?.depth).toBe(2);
  });

  it("walks several roots in order", () => {
    const stops = flattenPhotoStops([
      loc("EEEE", "Basement", "room"),
      loc("FFFF", "Attic", "room"),
    ]);
    expect(stops.map((s) => s.name)).toEqual(["Basement", "Attic"]);
  });
});
