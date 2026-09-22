import type { ImageOut } from "@cubby/schemas/image";
import { imageOut } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import {
  locationChildGroupLabel,
  resolveLocationVisual,
} from "./location-visual-resolver";

const image = (id: string, overrides: Partial<ImageOut> = {}): ImageOut =>
  imageOut.parse({
    id: testShortcode("image", `IMG-${id}`),
    url: `https://example.test/${id}.jpg`,
    key: `${id}.jpg`,
    filename: `${id}.jpg`,
    size: 100,
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
    capturedAt: null,
    capturedAtOffsetMinutes: null,
    captureLocation: null,
    capturePlaceName: null,
    captureDeviceLabel: null,
    capturedByPartyId: null,
    capturedByName: null,
    captureAttribution: "none",
    provenanceEvidence: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });

const location = (
  code: string,
  type: LocationType | null,
  overrides: Partial<InfLocation> = {},
): InfLocation => ({
  id: testShortcode("location", `LOC-${code}`),
  name: `Location ${code}`,
  aliases: [],
  type,
  product: null,
  lastBulkInventory: null,
  aiDescription: null,
  images: [],
  valuation: null,
  dataQuality: testCompleteDataQuality(),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  children: [],
  ...overrides,
  notes: overrides.notes ?? null,
});

describe("resolveLocationVisual", () => {
  it("prefers an own photo over the linked product and children", () => {
    const own = image("own");
    const product = image("product");
    const child = location("BBBB", "drawer", { images: [image("child")] });
    const result = resolveLocationVisual(
      location("AAAA", null, {
        images: [own],
        product: {
          id: testShortcode("product", "PRD-AAAA"),
          name: "Two drawer box",
          manufacturer: "Example",
          model: null,
          category: categorySummaryFixture("storage"),
          coverImage: product,
          price: 50,
        },
        children: [child],
      }),
    );

    expect(result.primaryImage).toBe(own);
    expect(result.primarySource).toBe("location");
    expect(result.childVisuals).toHaveLength(1);
  });

  it("falls back through product, child, then none", () => {
    const product = image("product");
    const childImage = image("child");
    const child = location("BBBB", "drawer", { images: [childImage] });
    const productBacked = location("AAAA", null, {
      product: {
        id: testShortcode("product", "PRD-AAAA"),
        name: "Two drawer box",
        manufacturer: "Example",
        model: null,
        category: categorySummaryFixture("storage"),
        coverImage: product,
        price: null,
      },
      children: [child],
    });

    expect(resolveLocationVisual(productBacked).primarySource).toBe("product");
    expect(
      resolveLocationVisual(location("CCCC", "box", { children: [child] }))
        .primarySource,
    ).toBe("child");
    expect(resolveLocationVisual(location("DDDD", "box")).primarySource).toBe(
      "none",
    );
  });

  it("skips unusable images and caps previews at four in child order", () => {
    const children = Array.from({ length: 6 }, (_, index) =>
      location(`A${index}AA`, "drawer", {
        images: [
          image(`bad-${index}`, { contentType: "application/pdf" }),
          image(`good-${index}`),
        ],
      }),
    );
    const result = resolveLocationVisual(location("ZZZZ", "box", { children }));

    expect(result.childVisuals.map((child) => child.image.filename)).toEqual([
      "good-0.jpg",
      "good-1.jpg",
      "good-2.jpg",
      "good-3.jpg",
    ]);
    expect(result.hiddenChildCount).toBe(2);
  });
});

describe("locationChildGroupLabel", () => {
  it("uses a homogeneous physical type and falls back for mixed children", () => {
    expect(
      locationChildGroupLabel([
        location("AAAA", "drawer"),
        location("BBBB", "drawer"),
      ]),
    ).toBe("drawers");
    expect(
      locationChildGroupLabel([
        location("AAAA", "drawer"),
        location("BBBB", "shelf"),
      ]),
    ).toBe("Compartments");
  });
});
