import { describe, expect, it } from "vitest";

import {
  expectedHarvestFor,
  guideBandMonthsFor,
  guideWindowsFor,
  plantRoutesFor,
} from "./windows";

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

describe("guideBandMonthsFor", () => {
  // The timeline draws one band per method that has a window, so a
  // transplant-only crop still gets a band.
  it.each([
    ["tomato" as const, { sow: null, transplant: [4, 5, 6] }],
    ["leek" as const, { sow: [2, 3, 4], transplant: [2, 3, 4] }],
    [null, { sow: null, transplant: null }],
  ])("resolves %s to %o", (key, expected) => {
    expect(guideBandMonthsFor(key)).toEqual(expected);
  });
});

describe("plantRoutesFor", () => {
  it.each([
    // Seed routes read the sow window; `bought` reads the transplant window.
    [
      "tomato" as const,
      5,
      "tray: sow (no guide window), plant out Apr–Jun · indoor: sow (no guide window), plant out Apr–Jun · bought: plant out now",
    ],
    [
      "leek" as const,
      9,
      "tray: sow Feb–Apr, plant out Feb–Apr · indoor: sow Feb–Apr, plant out Feb–Apr",
    ],
    // A practice-only crop has starts but no citable window.
    [
      "cilantro" as const,
      3,
      "direct: sow (no guide window) · tray: sow (no guide window)",
    ],
    [null, 3, null],
  ])("reads %s in month %i", (key, month, expected) => {
    expect(plantRoutesFor(key, month)).toBe(expected);
  });
});

describe("expectedHarvestFor", () => {
  const noPacket = {
    daysFromSowMin: null,
    daysFromSowMax: null,
    daysFromTransplantMin: null,
    daysFromTransplantMax: null,
  };
  it.each([
    [
      "transplant date plus the crop's transplant range",
      {
        key: "tomato" as const,
        plant: noPacket,
        sowedOn: null,
        transplantedOn: "2026-05-01",
      },
      {
        start: "2026-06-29",
        end: "2026-07-18",
        basis: "Johnny's Selected Seeds",
      },
    ],
    [
      "cultivar packet days win over the crop range",
      {
        key: "tomato" as const,
        plant: { ...noPacket, daysFromTransplantMin: 57 },
        sowedOn: "2026-03-01",
        transplantedOn: "2026-05-01",
      },
      { start: "2026-06-27", end: "2026-06-27", basis: "cultivar packet" },
    ],
    [
      "sow date plus the sow range for a direct-sown crop",
      {
        key: "carrot" as const,
        plant: noPacket,
        sowedOn: "2026-03-01",
        transplantedOn: null,
      },
      {
        start: "2026-04-26",
        end: "2026-05-15",
        basis: "Johnny's Selected Seeds",
      },
    ],
    [
      // Late rather than early: the safe side for a guess.
      "a transplant with only sow-based days counts them from the transplant",
      {
        key: "carrot" as const,
        plant: noPacket,
        sowedOn: null,
        transplantedOn: "2026-03-01",
      },
      {
        start: "2026-04-26",
        end: "2026-05-15",
        basis: "Johnny's Selected Seeds",
      },
    ],
  ])("%s", (_label, args, expected) => {
    expect(expectedHarvestFor(args)).toMatchObject(expected);
  });

  it("is null without a real date", () => {
    expect(
      expectedHarvestFor({
        key: "tomato",
        plant: noPacket,
        sowedOn: null,
        transplantedOn: null,
      }),
    ).toBeNull();
  });
});
