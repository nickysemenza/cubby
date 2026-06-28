import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getInventoryByLocationIds } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  approveDetectedInventoryItem,
  isDetectedItemCoveredByInventoryName,
} from "./ai-enrichment.service";

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
        locationId: location.id,
        item: detectedItem,
      },
      ctx.actor,
    );

    expect(result.createdProduct).toBe(false);
    expect(result.productId).toBe(product.id);

    const inventory = await getInventoryByLocationIds(ctx.db, [location.id]);
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
        locationId: location.id,
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

    const inventory = await getInventoryByLocationIds(ctx.db, [location.id]);
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
        locationId: location.id,
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

    const inventory = await getInventoryByLocationIds(ctx.db, [location.id]);
    expect(inventory[0]?.product.name).toBe("misc: unidentified cables");
  });
});

describe("isDetectedItemCoveredByInventoryName", () => {
  it("treats a generic cached detection as covered by a more specific inventoried product", () => {
    expect(
      isDetectedItemCoveredByInventoryName("drop cloth", "plastic drop cloth"),
    ).toBe(true);
    expect(
      isDetectedItemCoveredByInventoryName("plastic tarp", "blue plastic tarp"),
    ).toBe(true);
  });

  it("does not dedupe single-token broad matches", () => {
    expect(isDetectedItemCoveredByInventoryName("tarp", "tarp clips")).toBe(
      false,
    );
  });
});
