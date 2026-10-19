import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import { presentEntitySelectOptions } from "./select-options";

describe("presentEntitySelectOptions", () => {
  it("completes a status roster with tones, the status role and glyph icons", () => {
    const options = presentEntitySelectOptions("example", "state", [
      { value: "active", label: "Active" },
      { value: "pending_review", label: "Pending review" },
      { value: "blocked", label: "Blocked" },
    ]);

    expect(
      options.map(({ value, color, role, glyph }) => ({
        value,
        color,
        role,
        glyph: glyph?.phosphor,
      })),
    ).toEqual([
      {
        value: "active",
        color: "var(--positive)",
        role: "status",
        glyph: "CheckCircle",
      },
      {
        value: "pending_review",
        color: "var(--warning)",
        role: "status",
        glyph: "Clock",
      },
      {
        value: "blocked",
        color: "var(--destructive)",
        role: "status",
        glyph: "Prohibit",
      },
    ]);
    // A declared or inferred glyph becomes the picker's leading icon.
    expect(options.every((option) => isValidElement(option.icon))).toBe(true);
  });

  it("keeps a caller's icon and color authoritative and appends sentinels", () => {
    const options = presentEntitySelectOptions("expense", "lineKind", [
      {
        value: "item_line",
        label: "Broken",
        color: "var(--custom)",
        icon: "x",
      },
    ]);

    expect(
      options.map(({ value, color, icon }) => ({ value, color, icon })),
    ).toEqual([
      { value: "item_line", color: "var(--custom)", icon: "x" },
      { value: "auto", color: "var(--category-1)", icon: undefined },
    ]);
  });
});
