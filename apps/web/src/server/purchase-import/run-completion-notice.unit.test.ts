import { expect, it } from "vitest";

import { runCompletionNotice } from "./run-completion-notice";

const base = {
  input: null,
  vendorId: "vendor-1",
  vendorName: "Example Seeds",
  terminalStatus: "completed" as const,
  imported: 0,
  updated: 0,
  skipped: 0,
  findingCount: 0,
  targetStates: [],
};

// A finished enrichment run once announced "Purchase import complete: 0
// orders changed" on the Mac, although it worked Products, not orders.
it("announces an enrichment run in Products", () => {
  expect(
    runCompletionNotice({
      ...base,
      purpose: "product_enrichment",
      targetStates: ["completed", "skipped", "skipped", "needs_evidence"],
      findingCount: 1,
    }),
  ).toEqual({
    title: "Example Seeds: Product enrichment complete",
    body: "1 of 4 products enriched; 2 skipped; 1 waiting on you. 1 item needs review.",
  });
});

it("announces an order sync in orders", () => {
  expect(
    runCompletionNotice({
      ...base,
      purpose: "account_sync",
      terminalStatus: "needs_review",
      imported: 2,
      updated: 1,
      skipped: 1,
    }),
  ).toEqual({
    title: "Example Seeds: Order history sync needs review",
    body: "3 orders changed; 1 skipped.",
  });
});
