import { describe, expect, it } from "vitest";

import { presentEntitySelectOptions } from "./select-options";

describe("presentEntitySelectOptions", () => {
  it("merges rich options, preserves declared presentation, and assigns semantic colors", () => {
    const icon = "rich-icon";
    const options = presentEntitySelectOptions("example", "state", [
      { value: "active", label: "Active" },
      { value: "pending_review", label: "Pending review" },
      { value: "mismatched", label: "Mismatched" },
      { value: "planned", label: "Planned" },
      { value: "custom", label: "Custom", icon },
    ]);

    expect(options).toEqual([
      { value: "active", label: "Active", color: "var(--positive)" },
      {
        value: "pending_review",
        label: "Pending review",
        color: "var(--warning)",
      },
      { value: "mismatched", label: "Mismatched", color: "var(--destructive)" },
      { value: "planned", label: "Planned", color: "var(--brand-domain-plan)" },
      {
        value: "custom",
        label: "Custom",
        icon,
        color: "var(--brand-domain-house)",
      },
    ]);
  });

  it("keeps explicit colors and icons authoritative while appending rich options", () => {
    const options = presentEntitySelectOptions("expense", "lineKind", [
      { value: "item_line", label: "Broken", color: "var(--custom)" },
    ]);

    expect(options).toEqual([
      { value: "item_line", label: "Broken", color: "var(--custom)" },
      {
        value: "auto",
        label: "Auto-detect from name",
        color: "var(--brand-domain-house)",
      },
    ]);
  });
});
