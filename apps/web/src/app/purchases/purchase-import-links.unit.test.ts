import { describe, expect, it } from "vitest";

import { purchaseImportRunHref } from "./purchase-import-links";

describe("purchase import run links", () => {
  it("uses the public PIR address for the canonical run detail", () => {
    expect(purchaseImportRunHref("RUN-4K7M")).toBe(
      "/purchase-imports/RUN-4K7M",
    );
  });
});
