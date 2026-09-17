import { describe, expect, it } from "vitest";

import { guideWindowsFor } from "./windows";

describe("guideWindowsFor", () => {
  it.each([
    // Household microclimate (`sunny`) has a transplant window; no sow/direct-sow
    // window exists for tomato at all.
    ["tomato" as const, { sow: null, transplant: "Apr–Jun" }],
    // No `sunny` sow window exists for leek, so sow falls back to the `bay-area`
    // window; a `sunny` transplant window exists, so transplant uses it directly.
    ["leek" as const, { sow: "Feb–Apr", transplant: "Feb–Apr" }],
    // Potato is only ever recorded by `tuber`/`unspecified` methods — neither
    // `sow`/`direct-sow` nor `transplant` — so both sides are null.
    ["potato" as const, { sow: null, transplant: null }],
  ])("resolves %s to %o", (key, expected) => {
    expect(guideWindowsFor(key)).toEqual(expected);
  });

  it("returns null on both sides for a crop with no guide", () => {
    expect(guideWindowsFor(null)).toEqual({ sow: null, transplant: null });
  });
});
