import { describe, expect, it } from "vitest";
import { colorizeEnumOptions } from "./enum-palette";

// Failure modes: categories borrowing domain or condition hues, a status roster
// read as categories (no glyphs), the blanket legacy slate graying out kinds,
// missing category glyphs, unknown values looking urgent, lost overrides, and
// changed colors or roles after filtering.
describe("shared enum palette", () => {
  it("cycles the category palette for kinds and keeps explicit overrides", () => {
    const options = colorizeEnumOptions([
      { value: "consumable" },
      { value: "durable", color: "var(--slate)" },
      { value: "unknown" },
      { value: "custom", color: "var(--brand-domain-finance)" },
    ]);
    expect(options.map((option) => option.role)).toEqual([
      "category",
      "category",
      "category",
      "category",
    ]);
    expect(options.map((option) => option.color)).toEqual([
      "var(--category-1)",
      "var(--category-2)",
      "var(--neutral-status)",
      "var(--brand-domain-finance)",
    ]);
    expect(options.every((option) => option.glyph !== undefined)).toBe(true);
    expect(colorizeEnumOptions(options.slice(1))).toEqual(options.slice(1));
  });

  it("reads an all-condition roster as status with a glyph per state", () => {
    const options = colorizeEnumOptions([
      { value: "not_started" },
      { value: "in_progress" },
      { value: "blocked" },
      { value: "done" },
    ]);
    expect(options.map((option) => [option.role, option.color])).toEqual([
      ["status", "var(--neutral-status)"],
      ["status", "var(--info)"],
      ["status", "var(--destructive)"],
      ["status", "var(--positive)"],
    ]);
    expect(options.map((option) => option.glyph?.phosphor)).toEqual([
      "CircleDashed",
      "CircleHalf",
      "Prohibit",
      "CheckCircle",
    ]);
    expect(colorizeEnumOptions(options.slice(2))).toEqual(options.slice(2));
  });

  it("reads explicit slate in a condition roster as the neutral state", () => {
    const options = colorizeEnumOptions([
      { value: "match" },
      { value: "explained", color: "var(--slate)" },
      { value: "mismatch" },
    ]);
    expect(options.map((option) => [option.role, option.color])).toEqual([
      ["status", "var(--positive)"],
      ["status", "var(--neutral-status)"],
      ["status", "var(--destructive)"],
    ]);
  });

  it("honors a declared role and icon over inference", () => {
    const [option] = colorizeEnumOptions(
      [
        {
          value: "travel",
          glyph: { phosphor: "Airplane", sfSymbol: "airplane" },
        },
      ],
      "category",
    );
    expect(option).toMatchObject({
      role: "category",
      color: "var(--category-1)",
      glyph: { phosphor: "Airplane", sfSymbol: "airplane" },
    });
  });

  it("normalizes legacy chart inks into shared roles", () => {
    expect(
      colorizeEnumOptions([
        { value: "working", color: "var(--chart-1)" },
        { value: "done", color: "var(--chart-positive)" },
        { value: "note", color: "var(--plum)" },
      ]).map((option) => option.color),
    ).toEqual(["var(--category-1)", "var(--positive)", "var(--category-5)"]);
    // A legacy hue on a state value kept a whole status roster a category.
    expect(
      colorizeEnumOptions([
        { value: "not_started", color: "var(--chart-neutral)" },
        { value: "in_progress", color: "var(--chart-1)" },
        { value: "done", color: "var(--chart-positive)" },
      ]).map((option) => [option.role, option.color]),
    ).toEqual([
      ["status", "var(--neutral-status)"],
      ["status", "var(--info)"],
      ["status", "var(--positive)"],
    ]);
  });
});
