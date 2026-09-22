import { describe, expect, it } from "vitest";

import { importRunHref } from "./purchase-import-links";

describe("purchase import run links", () => {
  it("uses the public PIR address for the canonical run detail", () => {
    expect(importRunHref("RUN-4K7M")).toBe("/import-runs/RUN-4K7M");
  });
});
