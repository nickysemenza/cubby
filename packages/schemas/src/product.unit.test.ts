import { describe, expect, it } from "vitest";
import { productCreateInput, productUpdateData } from "./product";

const IMAGE_ID = "123e4567-e89b-12d3-a456-426614174000";

const createPayload = {
  name: "Flour",
  upc: null,
  manufacturer: "Generic",
  expectedQuantity: null,
  ingredientId: null,
};

describe("productCreateInput schema", () => {
  it("accepts pending images on create", () => {
    const parsed = productCreateInput.parse({
      ...createPayload,
      pendingImageIds: [IMAGE_ID],
    });

    expect(parsed.pendingImageIds).toEqual([IMAGE_ID]);
  });

  it("does not include update-only image removal on create", () => {
    const parsed = productCreateInput.parse({
      ...createPayload,
      removeImageIds: [IMAGE_ID],
    });

    expect("removeImageIds" in parsed).toBe(false);
  });
});

describe("productUpdateData schema", () => {
  it("accepts image removal on update", () => {
    const parsed = productUpdateData.parse({
      removeImageIds: [IMAGE_ID],
    });

    expect(parsed.removeImageIds).toEqual([IMAGE_ID]);
  });

  it("does not default omitted relationship fields on partial updates", () => {
    const parsed = productUpdateData.parse({});

    expect("fdc_id" in parsed).toBe(false);
    expect("unitMappings" in parsed).toBe(false);
    expect("externalIds" in parsed).toBe(false);
  });
});
