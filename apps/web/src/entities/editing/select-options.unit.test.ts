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
      { value: "planned", label: "Planned", color: "var(--chart-4)" },
      { value: "custom", label: "Custom", icon, color: "var(--chart-1)" },
    ]);
  });

  it("keeps explicit colors and icons authoritative while appending rich options", () => {
    const options = presentEntitySelectOptions("image", "status", [
      { value: "FAILED", label: "Broken", color: "var(--custom)" },
    ]);

    expect(options).toEqual([
      { value: "FAILED", label: "Broken", color: "var(--custom)" },
      { value: "PENDING", label: "Pending", color: "var(--slate)" },
      { value: "UPLOADED", label: "Uploaded", color: "var(--positive)" },
    ]);
  });

  it("uses slate for neutral lifecycle values and cycles stable chart tokens", () => {
    const options = presentEntitySelectOptions("example", "state", [
      { value: "unknown", label: "Unknown" },
      { value: "unverified", label: "Unverified" },
      { value: "disabled", label: "Disabled" },
      { value: "finished", label: "Finished" },
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
      { value: "six", label: "Six" },
    ]);

    expect(options.map(({ color }) => color)).toEqual([
      "var(--slate)",
      "var(--slate)",
      "var(--slate)",
      "var(--slate)",
      "var(--chart-1)",
      "var(--chart-2)",
      "var(--chart-3)",
    ]);
  });
});
