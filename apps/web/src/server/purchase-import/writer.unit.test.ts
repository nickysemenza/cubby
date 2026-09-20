import { describe, expect, it } from "vitest";

import { lineExternalIdentity } from "./writer";

describe("purchase import line identity", () => {
  it("groups duplicate vendor SKUs before independent identity decisions", () => {
    const vendorId = "11111111-1111-4111-8111-111111111111";
    expect(
      lineExternalIdentity(
        { sku: "SKU-42", productUrl: "https://shop.example.test/p/first" },
        vendorId,
      ),
    ).toBe(
      lineExternalIdentity(
        { sku: "SKU-42", productUrl: "https://shop.example.test/p/second" },
        vendorId,
      ),
    );
  });

  it("does not group lines that have no stable vendor SKU", () => {
    expect(
      lineExternalIdentity(
        { productUrl: "https://shop.example.test/p/first" },
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toBeNull();
  });
});
