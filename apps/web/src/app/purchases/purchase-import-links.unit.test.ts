import { describe, expect, it } from "vitest";

import { runHref } from "./purchase-import-links";

describe("purchase import run links", () => {
  it("uses the public PIR address for the canonical run detail", () => {
    expect(runHref("RUN-4K7M")).toBe("/runs/RUN-4K7M");
  });
});
