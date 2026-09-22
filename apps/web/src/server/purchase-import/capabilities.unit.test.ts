import { describe, expect, it } from "vitest";

import {
  assertImportRunCapability,
  capabilityForPurchaseAgentTool,
} from "./capabilities";

describe("targeted import capabilities", () => {
  it("refuses every business writer capability for purchase validation", () => {
    for (const capability of [
      "commit_purchase_import",
      "business_writer",
      "generic_mutation",
      "attachment",
      "audit_repair",
      "enrichment_commit",
    ] as const) {
      expect(() =>
        assertImportRunCapability("purchase_validation", capability),
      ).toThrow("forbids");
    }
  });

  it("retains account-sync's existing mutation permissions", () => {
    expect(() =>
      assertImportRunCapability("account_sync", "business_writer"),
    ).not.toThrow();
    expect(() =>
      assertImportRunCapability("account_sync", "audit_repair"),
    ).not.toThrow();
  });

  it("lets every run purpose propose a product match without granting business writes", () => {
    const capability = capabilityForPurchaseAgentTool(
      "propose_product_match",
      true,
    );
    expect(capability).toBe("match_proposal");
    for (const purpose of [
      "account_sync",
      "purchase_validation",
      "product_enrichment",
      "photo_inventory",
    ] as const) {
      expect(() =>
        assertImportRunCapability(purpose, "match_proposal"),
      ).not.toThrow();
    }
  });
});
