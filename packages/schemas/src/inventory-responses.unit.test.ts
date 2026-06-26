import { describe, expect, it } from "vitest";
import { inventoryListItemOut } from "./inventory-responses";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const PRODUCT_ID = "223e4567-e89b-12d3-a456-426614174000";
const LOCATION_ID = "323e4567-e89b-12d3-a456-426614174000";

describe("inventoryListItemOut schema", () => {
  it("keeps product and location list embeds lean", () => {
    const now = new Date();
    const parsed = inventoryListItemOut.parse({
      id: UUID,
      amount: { value: 1, unit: "each" },
      valuation: null,
      createdAt: now,
      updatedAt: now,
      product: {
        id: PRODUCT_ID,
        shortcode: "P-TEST",
        name: "Flour",
        manufacturer: "Generic",
        upc: null,
        fdc_id: null,
        category: null,
        expectedQuantity: null,
        model: null,
        price: null,
        usdaUnavailable: null,
        images: [],
        unitMappings: [],
        externalIds: [],
      },
      location: {
        id: LOCATION_ID,
        shortcode: "L-TEST",
        name: "Pantry",
        type: "room",
        images: [],
      },
    });

    expect("images" in parsed.product).toBe(false);
    expect("unitMappings" in parsed.product).toBe(false);
    expect("externalIds" in parsed.product).toBe(false);
    expect("images" in parsed.location).toBe(false);
  });
});
