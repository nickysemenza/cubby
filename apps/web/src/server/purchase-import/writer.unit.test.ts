import { describe, expect, it } from "vitest";

import { buildPurchaseImportPlan, lineExternalIdentity } from "./writer";

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

  it("groups Amazon lines by canonical ASIN when no retailer SKU was extracted", () => {
    const vendorId = "11111111-1111-4111-8111-111111111111";
    expect(
      lineExternalIdentity(
        { productUrl: "https://www.amazon.com/dp/B012345678?ref_=orders" },
        vendorId,
      ),
    ).toBe(
      lineExternalIdentity(
        { productUrl: "https://amazon.com/gp/product/B012345678/" },
        vendorId,
      ),
    );
  });
});

describe("purchase import semantic plan", () => {
  const candidate = {
    orderId: "ORDER-1",
    orderedAt: "2026-09-20T12:00:00.000Z",
    merchant: "Example",
    currency: "USD",
    printedGrandTotal: 12.34,
    lines: [
      {
        title: "Example item",
        amount: 12.34,
        lineKind: "principal" as const,
      },
    ],
    payments: [],
    allShipmentsDelivered: true,
  };

  it("carries the writer's foreign-currency refusal into validation", () => {
    expect(
      buildPurchaseImportPlan({
        status: "ready",
        candidate: { ...candidate, currency: "EUR" },
      }).writeBlockReason,
    ).toBe("foreign_currency");
  });

  it("carries extraction review refusals into validation", () => {
    expect(
      buildPurchaseImportPlan({
        status: "needs_review",
        candidate,
        reason: "sum_mismatch",
        detail: "The printed total does not match the extracted lines.",
      }).writeBlockReason,
    ).toBe("sum_mismatch");
  });
});
