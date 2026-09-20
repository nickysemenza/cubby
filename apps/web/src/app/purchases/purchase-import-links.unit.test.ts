import { describe, expect, it } from "vitest";

import { purchaseImportRunHref } from "./purchase-import-links";

describe("purchase import run links", () => {
  it("uses the public PIR address for the canonical run detail", () => {
    expect(purchaseImportRunHref("PIR-ABCDE12345")).toBe(
      "/purchase-imports/PIR-ABCDE12345",
    );
  });
});
