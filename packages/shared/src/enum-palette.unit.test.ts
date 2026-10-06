import { describe, expect, it } from "vitest";
import { colorizeEnumOptions } from "./enum-palette";

// Failure modes: neutral first category, statuses sharing category hues, lost overrides,
// changed colors after filtering, and legacy web tokens missing adaptive native equivalents.
describe("shared enum palette", () => {
  it("separates categories while keeping status semantics and explicit overrides", () => {
    const options = colorizeEnumOptions([
      { value: "consumable" },
      { value: "durable" },
      { value: "unknown" },
      { value: "failed" },
      { value: "completed" },
      { value: "custom", color: "var(--brand-domain-finance)" },
    ]);
    expect(options[0]?.color).toBe("var(--brand-domain-house)");
    expect(options[1]?.color).toBe("var(--brand-domain-plan)");
    expect(options[2]?.color).toBe("var(--warning)");
    expect(options[3]?.color).toBe("var(--destructive)");
    expect(options[4]?.color).toBe("var(--positive)");
    expect(options[5]?.color).toBe("var(--brand-domain-finance)");
    expect(colorizeEnumOptions(options.slice(1))).toEqual(options.slice(1));
  });

  it("normalizes legacy chart and action inks into shared enum color roles", () => {
    expect(
      colorizeEnumOptions([
        { value: "working", color: "var(--chart-1)" },
        { value: "done", color: "var(--chart-positive)" },
        { value: "paused", color: "var(--info)" },
        { value: "note", color: "var(--plum)" },
      ]).map((option) => option.color),
    ).toEqual([
      "var(--brand-domain-house)",
      "var(--positive)",
      "var(--brand-domain-house)",
      "var(--brand-domain-plan)",
    ]);
  });
});
