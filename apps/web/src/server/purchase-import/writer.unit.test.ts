import type { ExtractedPurchaseLine } from "@cubby/schemas/purchase-import";
import { describe, expect, it, vi } from "vitest";

import type { JevChoiceResult } from "~/server/ai/jev";

import {
  buildPurchaseImportPlan,
  explicitLineDecisions,
  lineExternalIdentity,
  purchaseDateFor,
} from "./writer";

describe("purchase date", () => {
  it("is the household-local day of an evening Pacific order, not its UTC day", () => {
    // 9:32 PM PDT on Sep 22 is already Sep 23 in UTC.
    expect(purchaseDateFor("2026-09-23T04:32:43.000Z", null)).toBe(
      "2026-09-22",
    );
  });

  it("keeps an existing Purchase's date when the evidence states none", () => {
    expect(purchaseDateFor(null, "2026-08-14")).toBe("2026-08-14");
  });

  it("keeps the date unknown for a new identified incomplete Purchase", () => {
    expect(purchaseDateFor(null, null)).toBeNull();
  });
});

describe("purchase import line identity", () => {
  it("groups duplicate vendor SKUs before independent identity decisions", () => {
    const source = "example-store";
    expect(
      lineExternalIdentity(
        { sku: "SKU-42", productUrl: "https://shop.example.test/p/first" },
        source,
      ),
    ).toBe(
      lineExternalIdentity(
        { sku: "SKU-42", productUrl: "https://shop.example.test/p/second" },
        source,
      ),
    );
  });

  it("keeps the same SKU separate for distinct resolved issuer sources", () => {
    const line = { sku: "SHARED-17" };
    expect(lineExternalIdentity(line, "host-616c706861")).not.toBe(
      lineExternalIdentity(line, "host-62657461"),
    );
  });

  it("does not group lines that have no stable vendor SKU", () => {
    expect(
      lineExternalIdentity(
        { productUrl: "https://shop.example.test/p/first" },
        "example-store",
      ),
    ).toBeNull();
  });

  it("groups Amazon lines by canonical ASIN when no retailer SKU was extracted", () => {
    const source = "example-store";
    expect(
      lineExternalIdentity(
        { productUrl: "https://www.amazon.com/dp/B012345678?ref_=orders" },
        source,
      ),
    ).toBe(
      lineExternalIdentity(
        { productUrl: "https://amazon.com/gp/product/B012345678/" },
        source,
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

describe("explicitLineDecisions", () => {
  const line = (
    overrides: Partial<ExtractedPurchaseLine>,
  ): ExtractedPurchaseLine => ({
    title: "Example item",
    amount: 10,
    lineKind: "principal",
    ...overrides,
  });

  const noReversal = vi.fn<() => Promise<JevChoiceResult>>();

  it("decides every line when only principal lines carry a resolution, leaving adjustments unresolved by design", async () => {
    const lines = [
      line({ title: "Widget", amount: 20, lineKind: "principal" }),
      line({ title: "Sales tax", amount: 2, lineKind: "tax" }),
      line({ title: "Shipping", amount: 5, lineKind: "shipping" }),
      line({ title: "Coupon", amount: -3, lineKind: "discount" }),
      line({ title: "Gadget", amount: 15, lineKind: "principal" }),
    ];
    const resolutions = [
      { kind: "existing" as const, lineIndex: 0, productId: "product-1" },
      { kind: "new" as const, lineIndex: 4 },
    ];

    const decisions = await explicitLineDecisions(
      lines,
      resolutions,
      noReversal,
    );

    expect(decisions).toHaveLength(5);
    expect(decisions[0]).toMatchObject({
      productId: "product-1",
      promote: false,
      lineKind: "principal",
    });
    expect(decisions[4]).toMatchObject({
      productId: null,
      promote: true,
      lineKind: "principal",
    });
    // Tax, shipping, and discount lines never carry a Product: the explicit
    // resolution roster is keyed to principal lines only.
    for (const index of [1, 2, 3]) {
      expect(decisions[index]).toMatchObject({
        productId: null,
        promote: false,
        lineKind: lines[index]?.lineKind,
        kitKind: "single",
        reversalKind: null,
      });
    }
    expect(noReversal).not.toHaveBeenCalled();
  });

  it("still throws when a principal line has no resolution", async () => {
    const lines = [
      line({ lineKind: "tax", amount: 2 }),
      line({ lineKind: "principal", amount: 20 }),
    ];

    await expect(explicitLineDecisions(lines, [], noReversal)).rejects.toThrow(
      "Missing product resolution for line 1",
    );
  });

  it("consults the reversal stage for a negative-amount principal line", async () => {
    const lines = [line({ lineKind: "principal", amount: -12 })];
    const resolutions = [
      { kind: "existing" as const, lineIndex: 0, productId: "product-1" },
    ];
    const resolveReversal = vi.fn<() => Promise<JevChoiceResult>>(async () => ({
      selectedIndex: 0,
      confidence: "high",
      probability: 0.9,
      ranked: [{ index: 0, probability: 0.9 }],
    }));

    const [decision] = await explicitLineDecisions(
      lines,
      resolutions,
      resolveReversal,
    );

    expect(resolveReversal).toHaveBeenCalledWith(0, lines[0]);
    expect(decision).toMatchObject({ reversalKind: "return" });
  });
});
