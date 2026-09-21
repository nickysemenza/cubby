import { productTopLevelOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import {
  entitySummaryResultSchema,
  projectEntityResult,
  slimProduct,
  slimProductDetail,
} from "./response-projection";

const productAttachmentImageOut = productTopLevelOut.shape.images.element;

const itemImage = mock(productAttachmentImageOut, {
  seed: 1,
  overrides: {
    id: testShortcode("image", "IMG-ITEM"),
    url: "https://images.example.test/item.jpg",
    contentType: "image/jpeg",
    source: "catalog",
    sourcePageUrl: "https://catalog.example.test/item",
    sourceAssetUrl: "https://cdn.example.test/item.jpg",
    sourceName: "Catalog example",
    useOriginal: true,
    purpose: null,
  },
});

const itemPdf = mock(productAttachmentImageOut, {
  seed: 2,
  overrides: {
    id: testShortcode("image", "IMG-PDF1"),
    url: "https://images.example.test/manual.pdf",
    contentType: "application/pdf",
    source: "own",
    sourcePageUrl: null,
    sourceAssetUrl: null,
    sourceName: null,
    useOriginal: false,
    purpose: "item",
  },
});

const labelImage = mock(productAttachmentImageOut, {
  seed: 3,
  overrides: {
    id: testShortcode("image", "IMG-LABEL"),
    url: "https://images.example.test/label.png",
    contentType: "image/png",
    source: "own",
    sourcePageUrl: null,
    sourceAssetUrl: null,
    sourceName: null,
    useOriginal: false,
    purpose: "label",
  },
});

describe("product MCP response projection", () => {
  it("preserves all attachments and their evidence while only item images supply a cover", () => {
    const product = mock(productTopLevelOut, {
      seed: 4,
      overrides: {
        id: testShortcode("product", "PRD-PROJ"),
        images: [itemImage, itemPdf],
        labelImages: [labelImage],
      },
    });

    const summary = slimProduct(product);
    expect(summary).toMatchObject({
      imageCount: 3,
      itemImageCount: 1,
      labelImageCount: 1,
      coverImageUrl: itemImage.url,
    });

    const detail = slimProductDetail(product);
    expect(detail).toMatchObject({
      imageCount: 3,
      itemImageCount: 1,
      labelImageCount: 1,
      coverImageId: itemImage.id,
      coverImageUrl: itemImage.url,
    });
    expect(detail.images).toEqual([
      expect.objectContaining({
        id: itemImage.id,
        purpose: null,
        displayPosition: 1,
        isCover: true,
        source: "catalog",
        sourcePageUrl: "https://catalog.example.test/item",
        sourceAssetUrl: "https://cdn.example.test/item.jpg",
        sourceName: "Catalog example",
        useOriginal: true,
      }),
      expect.objectContaining({
        id: itemPdf.id,
        purpose: "item",
        displayPosition: null,
        isCover: false,
      }),
      expect.objectContaining({
        id: labelImage.id,
        purpose: "label",
        displayPosition: null,
        isCover: false,
      }),
    ]);
  });
});

describe("data-quality coverage projection", () => {
  // coverageFor is structural (any item carrying `dataQuality`), not a
  // product-only branch, so a non-product scored entity (purchase here)
  // must produce the identical coverage shape from an update result.
  it("projects coverage for a non-product scored entity carrying dataQuality", () => {
    const result = projectEntityResult(
      { resultDetail: "summary" },
      {
        action: "update",
        entity: "purchase",
        item: {
          id: "PUR-2ABC",
          displayName: "Synthetic purchase",
          dataQuality: {
            status: "needs_data",
            gaps: [
              { check: "order_id", kind: "missing" },
              { check: "paperwork_mismatch", kind: "defect" },
            ],
          },
        },
      },
    );

    expect(result).toMatchObject({
      item: {
        id: "PUR-2ABC",
        name: "Synthetic purchase",
        coverage: {
          status: "needs_data",
          missingChecks: ["order_id"],
          defectChecks: ["paperwork_mismatch"],
        },
      },
    });
  });

  it("omits coverage for entities with no dataQuality block", () => {
    const result = projectEntityResult(
      { resultDetail: "summary" },
      {
        action: "update",
        entity: "cookbook",
        item: { id: "CBK-2ABC", book: "Synthetic book" },
      },
    );

    expect(result).toMatchObject({ item: { id: "CBK-2ABC" } });
    const parsed = entitySummaryResultSchema.parse(result);
    expect(parsed.item?.coverage).toBeUndefined();
  });
});
