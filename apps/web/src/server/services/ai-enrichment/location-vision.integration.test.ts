import { unsafeImageShortcode } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  buildLocationAnalysisFingerprint,
  LOCATION_INVENTORY_DETECTION_FEATURE,
} from "~/server/ai/features";
import { upsertAiAnalysis } from "~/server/repo/ai-analysis";
import { listRecentAiUsage } from "~/server/repo/ai-usage";
import { createUploadedImageRecord } from "~/server/repo/image";
import { getInventoryByLocationIds } from "~/server/repo/inventory";
import { getLocationById, updateLocation } from "~/server/repo/location";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  approveDetectedInventoryItem,
  detectInventoryItems,
} from "./location-vision";

const detectedItem = {
  name: "blue tarp",
  manufacturer: "(unspecified)",
  estimatedQuantity: 1,
  unit: "each",
  category: "supplies" as const,
  confidence: "medium" as const,
  evidence: "Blue folded plastic material is visible.",
  isMisc: false,
};

describe("approveDetectedInventoryItem", () => {
  const ctx = withTestDb();

  it("inventories an existing matched product without creating a duplicate product", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "tarps cloths blankets" }),
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "blue tarp",
        manufacturer: "(unspecified)",
        category: "supplies",
      }),
      ctx.actor,
    );

    const result = await approveDetectedInventoryItem(
      ctx.db,
      {
        locationId: location.entityId,
        item: detectedItem,
      },
      ctx.actor,
    );

    expect(result.createdProduct).toBe(false);
    expect(result.productId).toBe(product.id);

    const inventory = await getInventoryByLocationIds(ctx.db, [
      location.entityId,
    ]);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.product.id).toBe(product.id);
  });

  it("creates a product then inventories it when no product matches", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "drop cloths" }),
      ctx.actor,
    );

    const result = await approveDetectedInventoryItem(
      ctx.db,
      {
        locationId: location.entityId,
        item: {
          ...detectedItem,
          name: "painters drop cloth",
          evidence: "A folded canvas drop cloth is visible.",
        },
      },
      ctx.actor,
    );

    expect(result.createdProduct).toBe(true);
    expect(result.productName).toBe("painters drop cloth");

    const inventory = await getInventoryByLocationIds(ctx.db, [
      location.entityId,
    ]);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.product.name).toBe("painters drop cloth");
    expect(inventory[0]?.product.category).toBe("supplies");
  });

  it("keeps misc names explicit for unidentified placeholders", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "cable box" }),
      ctx.actor,
    );

    await approveDetectedInventoryItem(
      ctx.db,
      {
        locationId: location.entityId,
        item: {
          ...detectedItem,
          name: "unidentified cables",
          category: "electronics",
          evidence: "A loose bundle of cables is visible.",
          isMisc: true,
        },
      },
      ctx.actor,
    );

    const inventory = await getInventoryByLocationIds(ctx.db, [
      location.entityId,
    ]);
    expect(inventory[0]?.product.name).toBe("misc: unidentified cables");
  });
});

describe("detectInventoryItems cached result filtering", () => {
  const ctx = withTestDb();

  it("filters approved equivalent inventory out of a cached AI result", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "tarps cloths blankets" }),
      ctx.actor,
    );
    const image = await createUploadedImageRecord(ctx.db, {
      key: "ai-inventory-cache-filter.jpg",
      filename: "ai-inventory-cache-filter.jpg",
      contentType: "image/jpeg",
      size: 123,
    });
    await updateLocation(
      ctx.db,
      location.entityId,
      { pendingImageIds: [unsafeImageShortcode(image.shortcode)] },
      ctx.actor,
    );
    const locationWithImage = await getLocationById(ctx.db, location.entityId);
    const inputFingerprint = buildLocationAnalysisFingerprint(
      LOCATION_INVENTORY_DETECTION_FEATURE,
      {
        locationName: locationWithImage.name,
        images: locationWithImage.images,
      },
    );
    await upsertAiAnalysis(
      ctx.db,
      {
        entityType: "location",
        entityId: location.entityId,
        feature: LOCATION_INVENTORY_DETECTION_FEATURE,
        inputFingerprint,
      },
      {
        summary: "Cached test result",
        items: [
          {
            ...detectedItem,
            name: "plastic tarp",
            evidence: "Blue plastic tarp material is visible.",
          },
          {
            ...detectedItem,
            name: "painters drop cloth",
            evidence: "Folded canvas drop cloth is visible.",
          },
        ],
      },
    );

    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "blue plastic tarp",
        manufacturer: "(unspecified)",
        category: "supplies",
      }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const batchId = "00000000-0000-4000-8000-000000000101";
    const result = await detectInventoryItems(ctx.db, location.entityId, {
      batchId,
    });

    expect(result.cache.status).toBe("hit");
    expect(result.items.map((item) => item.name)).toEqual([
      "painters drop cloth",
    ]);

    const usageRows = await listRecentAiUsage(ctx.db, 10);
    expect(
      usageRows.some(
        (row) =>
          row.feature === LOCATION_INVENTORY_DETECTION_FEATURE.feature &&
          row.cacheStatus === "hit" &&
          row.entityId === location.entityId &&
          row.batchId === batchId,
      ),
    ).toBe(true);
  });
});
