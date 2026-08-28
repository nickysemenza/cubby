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
