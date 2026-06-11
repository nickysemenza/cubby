import { describe, expect, test } from "vitest";
import { composeNotesMarkdown } from "./compactrecipe";

describe("composeNotesMarkdown", () => {
  test("composes headnote and tips into markdown", () => {
    expect(
      composeNotesMarkdown("A family favorite.", [
        "Freezes well",
        "Serve with rice",
      ]),
    ).toBe("A family favorite.\n\n- Freezes well\n- Serve with rice");
  });

  test("headnote only", () => {
    expect(composeNotesMarkdown("Just a blurb.", [])).toBe("Just a blurb.");
    expect(composeNotesMarkdown("Just a blurb.", null)).toBe("Just a blurb.");
  });

  test("tips only", () => {
    expect(composeNotesMarkdown(undefined, ["Make ahead up to 3 days"])).toBe(
      "- Make ahead up to 3 days",
    );
  });

  test("null when both are empty or blank", () => {
    expect(composeNotesMarkdown(undefined, undefined)).toBeNull();
    expect(composeNotesMarkdown("", [])).toBeNull();
    expect(composeNotesMarkdown("   ", ["", "  "])).toBeNull();
    expect(composeNotesMarkdown(null, null)).toBeNull();
  });

  test("trims whitespace and drops blank tips", () => {
    expect(composeNotesMarkdown("  blurb  ", ["  tip  ", ""])).toBe(
      "blurb\n\n- tip",
    );
  });
});
