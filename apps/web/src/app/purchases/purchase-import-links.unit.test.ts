import { describe, expect, it } from "vitest";

import { purchaseImportRunDebugHref } from "./purchase-import-links";

describe("purchase import run links", () => {
  it("preserves the run identity and targets the expanded debug section", () => {
    expect(purchaseImportRunDebugHref("run/with spaces?")).toBe(
      "/settings#purchase-import-run-run%2Fwith%20spaces%3F",
    );
  });
});
