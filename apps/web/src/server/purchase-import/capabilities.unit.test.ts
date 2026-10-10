import { runPurpose } from "@cubby/schemas/purchase-import";
import { describe, expect, it } from "vitest";

import {
  assertRunCapability,
  capabilityForPurchaseAgentAction,
} from "./capabilities";

describe("import run capabilities", () => {
  // Retrying Runs must not let a coordinator chain paid work.
  it("lets no run purpose start another run", () => {
    for (const purpose of runPurpose.options)
      expect(() =>
        assertRunCapability(
          purpose,
          capabilityForPurchaseAgentAction("run.lifecycle"),
        ),
      ).toThrow("forbids start_run");
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
        "photo_inventory",
        capabilityForPurchaseAgentAction("photo_run.commit_group"),
      ),
    ).not.toThrow();
    expect(() =>
      assertRunCapability(
        "photo_inventory",
        capabilityForPurchaseAgentAction("purchase_import.commit"),
      ),
    ).toThrow("forbids commit_purchase_import");
  });

  it("lets every agent run purpose propose a product match without granting business writes", () => {
    const capability = capabilityForPurchaseAgentAction(
      "product_enrichment.propose_match",
    );
    expect(capability).toBe("match_proposal");
    for (const purpose of ["mail_import", "photo_inventory"] as const) {
      expect(() =>
        assertRunCapability(purpose, "match_proposal"),
      ).not.toThrow();
    }
    expect(() =>
      assertRunCapability("photo_inventory", "business_writer"),
    ).toThrow("forbids business_writer");
  });
});
