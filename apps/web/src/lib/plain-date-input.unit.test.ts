import { describe, expect, it } from "vitest";

import { parsePlainDateInput } from "./plain-date-input";

const REFERENCE_DATE = new Date(2026, 7, 18, 9, 30);

describe("parsePlainDateInput", () => {
  it.each([
    ["2026-08-18", "2026-08-18"],
    ["8/18/2026", "2026-08-18"],
    ["Aug 18, 2026", "2026-08-18"],
    ["tomorrow", "2026-08-19"],
    ["next Friday", "2026-08-28"],
    ["two weeks from Thursday", "2026-09-03"],
    ["1 year ago", "2025-08-18"],
    ["one year ago", "2025-08-18"],
    ["2 months ago", "2026-06-18"],
    ["two weeks ago", "2026-08-04"],
    ["3 days ago", "2026-08-15"],
    ["one year from now", "2027-08-18"],
  ])("parses %s as %s", (input, expected) => {
    expect(parsePlainDateInput(input, REFERENCE_DATE)).toEqual({
      ok: true,
      value: expected,
    });
  });

  it("treats blank input as an unset date", () => {
    expect(parsePlainDateInput("  ", REFERENCE_DATE)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("clamps relative months and years to a valid calendar day", () => {
    expect(parsePlainDateInput("1 year ago", new Date(2024, 1, 29))).toEqual({
      ok: true,
      value: "2023-02-28",
    });
    expect(parsePlainDateInput("1 month ago", new Date(2026, 2, 31))).toEqual({
      ok: true,
      value: "2026-02-28",
    });
  });

  it.each([
    "February 30, 2026",
    "Aug 18 - Aug 20, 2026",
    "Aug 18, 2026 and Aug 20, 2026",
    "Aug 18, 2026 at 5pm",
    "remind me next Friday",
  ])("rejects %s", (input) => {
    expect(parsePlainDateInput(input, REFERENCE_DATE)).toMatchObject({
      ok: false,
    });
  });

  it("formats in local calendar time rather than shifting through UTC", () => {
    const lateLocalReference = new Date(2026, 7, 18, 23, 30);
    expect(parsePlainDateInput("tomorrow", lateLocalReference)).toEqual({
      ok: true,
      value: "2026-08-19",
    });
  });
});
