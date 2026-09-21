import { describe, expect, it } from "vitest";

import { assertImportRunCapability } from "./capabilities";

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
});
