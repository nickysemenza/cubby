import { type LocationDetailOut as InfLocation } from "@cubby/schemas/entities/location";
import { imageOut, type ImageOut } from "@cubby/schemas/image";
import { publicImageUrl } from "@cubby/schemas/image-summary";
import type { LocationType } from "@cubby/schemas/location";
import { productCategorySummary } from "@cubby/schemas/product-category-fields";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { categorySummaryFixture } from "tooling/product-category-fixtures";
import { describe, expect, it } from "vitest";

import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";
import {
  locationReadFixture,
  type LocationFixtureOverrides,
} from "~/features/location/location-read.fixtures";
import { locationChildGroupLabel } from "~/lib/location-child-label";

import { resolveLocationVisual } from "./location-visual-resolver";

const rawStorageCategory = categorySummaryFixture("storage");
const storageCategory = productCategorySummary.parse({
  id: rawStorageCategory.id,
  name: rawStorageCategory.name,
  fields: {
    path: fieldValueFixture(
      productCategorySummary.shape.fields.shape.path,
      rawStorageCategory.path,
    ),
  },
});

const image = (id: string, overrides: Partial<ImageOut> = {}): ImageOut =>
  entityReadFixture(imageOut, {
    fields: {
      url: fieldValueFixture(
        imageOut.shape.fields.shape.url,
        `https://example.test/${id}.jpg`,
      ),
      representations: fieldValueFixture(
        imageOut.shape.fields.shape.representations,
        {
          original: `https://example.test/${id}.jpg`,
          transparent: null,
          preferred: `https://example.test/${id}.jpg`,
          preferredKind: "original",
        },
      ),
    },
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
    sourceEvidence: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });

const location = (
  code: string,
  type: LocationType | null,
  overrides: LocationFixtureOverrides = {},
): InfLocation =>
  locationReadFixture({
    id: testShortcode("location", `LOC-${code}`),
    name: `Location ${code}`,
    aliases: [],
    type: type ?? "furniture",
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
    const child = location("BBBB", "drawer", { images: [image("child")] });
    const result = resolveLocationVisual(
      location("AAAA", null, {
        images: [own],
        displayImages: [{ ...own, url: publicImageUrl(own) }],
        product: {
          id: testShortcode("product", "PRD-AAAA"),
          name: "Two drawer box",
          brandName: "Example",
          model: null,
          category: storageCategory,

          price: 50,
        },
        children: [child],
      }),
    );

    expect(result.primaryImage).toMatchObject({
      id: own.id,
      url: publicImageUrl(own),
    });
    expect(result.primarySource).toBe("location");
    expect(result.childVisuals).toHaveLength(1);
  });

  it("uses the canonical product image and keeps child photos out of parent identity", () => {
    const product = image("product");
    const childImage = image("child");
    const child = location("BBBB", "drawer", { images: [childImage] });
    const productBacked = location("AAAA", null, {
      displayImages: [{ ...product, url: publicImageUrl(product) }],
      product: {
        id: testShortcode("product", "PRD-AAAA"),
        name: "Two drawer box",
        brandName: "Example",
        model: null,
        category: storageCategory,

        price: null,
      },
      children: [child],
    });

    expect(resolveLocationVisual(productBacked).primarySource).toBe("product");
    expect(
      resolveLocationVisual(location("CCCC", "box", { children: [child] }))
        .primarySource,
    ).toBe("none");
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
    expect(locationChildGroupLabel(["drawer", "drawer"])).toBe("drawers");
    expect(locationChildGroupLabel(["drawer", "shelf"])).toBe("Compartments");
  });
});
