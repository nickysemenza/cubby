import { describe, expect, it } from "vitest";

import {
  assertRunCapability,
  capabilityForPurchaseAgentAction,
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
        assertRunCapability("purchase_validation", capability),
      ).toThrow("forbids");
    }
  });

  it("retains account-sync's existing mutation permissions", () => {
    expect(() =>
      assertRunCapability("account_sync", "business_writer"),
    ).not.toThrow();
    expect(() =>
      assertRunCapability("account_sync", "audit_repair"),
    ).not.toThrow();
  });

  it("keys capability on the tool action, so one action never authorizes another", () => {
    expect(capabilityForPurchaseAgentAction("purchase_import.prepare")).toBe(
      "prepare",
    );
    expect(capabilityForPurchaseAgentAction("purchase_import.commit")).toBe(
      "commit_purchase_import",
    );
    expect(() =>
      assertRunCapability(
        "purchase_validation",
        capabilityForPurchaseAgentAction("purchase_import.prepare"),
      ),
    ).not.toThrow();
    expect(() =>
      assertRunCapability(
        "purchase_validation",
        capabilityForPurchaseAgentAction("purchase_import.commit"),
      ),
    ).toThrow("forbids commit_purchase_import");
  });

  it("lets every run purpose propose a product match without granting business writes", () => {
    const capability = capabilityForPurchaseAgentAction(
      "product_enrichment.propose_match",
    );
    expect(capability).toBe("match_proposal");
    for (const purpose of [
      "account_sync",
      "purchase_validation",
      "product_enrichment",
      "photo_inventory",
    ] as const) {
      expect(() =>
        assertRunCapability(purpose, "match_proposal"),
      ).not.toThrow();
    }
  });
});
