import { describe, expect, it } from "vitest";
import { compileEnumOptions } from "./enum-palette";

// Missing authoring metadata must stop generation; changing words, ordering or
// filtering must never invent presentation or alter another option's meaning.
describe("explicit enum presentation", () => {
  it("resolves contextual defaults without interpreting value spelling", () => {
    const options = compileEnumOptions(
      [
        { value: "bed", label: "Garden bed" },
        { value: "no", label: "No" },
      ],
      {
        role: "category",
        color: "domain-house",
        glyph: { phosphor: "Plant", sfSymbol: "leaf" },
      },
      "synthetic.locationType",
    );
    expect(
      options.map(({ color, glyph, role }) => ({ color, glyph, role })),
    ).toEqual(
      options.map(() => ({
        color: "var(--brand-domain-house)",
        glyph: { phosphor: "Plant", sfSymbol: "leaf" },
        role: "category",
      })),
    );
    expect(
      compileEnumOptions(
        [{ value: "renamed", color: "domain-house", glyph: options[0]!.glyph }],
        { role: "category" },
        "synthetic.renamed",
      )[0]?.glyph,
    ).toEqual(options[0]?.glyph);
  });

  it("uses only an explicitly selected status tone for the default glyph", () => {
    const [option] = compileEnumOptions(
      [{ value: "no", label: "No", color: "positive" }],
      { role: "status" },
      "synthetic.answer",
    );
    expect(option).toMatchObject({
      role: "status",
      color: "var(--positive)",
      glyph: { phosphor: "CheckCircle", sfSymbol: "checkmark.circle.fill" },
    });
  });

  it.each([
    [{ value: "new" }, {}, "role"],
    [{ value: "new", role: "category" }, {}, "color"],
    [{ value: "new", role: "category", color: "domain-house" }, {}, "glyph"],
    [
      { value: "new", role: "status", color: "domain-house" },
      {},
      "condition tone",
    ],
    [
      { value: "new", role: "category", color: "var(--chart-1)" },
      {},
      "color token",
    ],
  ])(
    "rejects incomplete or invalid authoring metadata",
    (option, defaults, missing) => {
      expect(() =>
        compileEnumOptions([option], defaults, "synthetic.field"),
      ).toThrow(new RegExp(`synthetic\\.field.*new.*${missing}`));
    },
  );
});
