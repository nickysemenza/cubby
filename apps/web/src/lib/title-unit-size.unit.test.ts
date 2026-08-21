import { describe, expect, it } from "vitest";
import { proposeSizeFromTitle } from "./title-unit-size";

/**
 * Runs against the real `parse_amount` grammar, not a stub — the whole design
 * is that Rust owns the parsing and the TS regex only locates a candidate.
 *
 * Every rejection case below is a REAL catalog title. They are the reason this
 * is a proposal rather than a bulk write.
 */
describe("proposeSizeFromTitle", () => {
  it("proposes the pack size when the title states exactly one", () => {
    // PRD-QQ9D, fixed by hand first: $2.73 a bag → $0.085/oz.
    const proposal = proposeSizeFromTitle("Bagged Yellow Onions, 32 OZ");
    expect(proposal?.amount).toEqual({ value: 32, unit: "oz" });
    expect(proposal?.token).toBe("32 OZ");
  });

  // Units come back CANONICALIZED by the Rust grammar ("gal" → "gallon"), which
  // is the point of parsing there rather than in a TS regex: the graph gets one
  // spelling per unit no matter how the title wrote it.
  it.each([
    ["15 oz. Fluorescent Red-Orange 2X Marking Spray Paint", 15, "oz"],
    ["Minwax Brushing Lacquer Aerosol Semi-Gloss Clear 12 oz.", 12, "oz"],
    ["Seventh Generation Laundry Detergent, Free & Clear, 40 oz", 40, "oz"],
    ["Whole Milk, 1 gal", 1, "gallon"],
    ["Isomalt Crystals, 2 lb", 2, "lb"],
  ])("reads %s", (title, value, unit) => {
    expect(proposeSizeFromTitle(title)?.amount).toEqual({ value, unit });
  });

  describe("refuses anything carrying a pack count", () => {
    // The core hazard: each of these parses to a per-each size that is 6-12x
    // too small, i.e. too CHEAP per ounce — the direction that quietly wins a
    // comparison. Refusing is the whole point.
    it.each([
      "La Croix Grapefruit Sparkling Water, 12-pack, 12 fl oz",
      "Califia Farms - Unsweetened Almond Barista Blend Almond Milk, 32 Oz (Pack Of 6), Shelf Stable",
      "Hi-Chew Strawberry Fruit Chews, 1.76 oz (Pack of 10)",
      "Ben's Original Ready Rice Whole Grain Brown Rice, 8.8oz (12-Pack)",
      "Zinsser 272479-6PK Bulls Eye 1-2-3 Plus Spray Primer, 13 oz, White, 6 Pack",
      "Bon Bon Swedish Sour Peach Fish Candy, 5.2oz (2-Pack)",
      "Clear PET Spray Bottles, 2 oz, 10-Pack",
    ])("refuses %s", (title) => {
      expect(proposeSizeFromTitle(title)).toBeNull();
    });

    it("refuses even when the size IS the total, because the title can't say so", () => {
      // Greenies is the inverted case — 27 oz genuinely is the whole bag, so a
      // naive parse would be RIGHT here. It is still refused: the grammar is
      // identical to La Croix's, so accepting it means accepting that one too.
      expect(
        proposeSizeFromTitle(
          "Greenies Original Petite Dog Dental Treats (27 oz, 45 ct)",
        ),
      ).toBeNull();
    });
  });

  it("refuses a dimension rather than a pack size", () => {
    // `weight`/`volume` only — no hand-maintained list of "not really units".
    expect(
      proposeSizeFromTitle("12 in. Pry Bar and 9 in. Nail Puller"),
    ).toBeNull();
    expect(
      proposeSizeFromTitle("48 in. W Garage Wall Storage GearTrack Channel"),
    ).toBeNull();
  });

  it("refuses when two different sizes appear", () => {
    // Which one is the each? Unanswerable from the string.
    expect(
      proposeSizeFromTitle(
        "Red Label Abrasives 2x42 Inch Belts, 5 lb and 2 lb assortment",
      ),
    ).toBeNull();
  });

  it("collapses a size repeated in the same title", () => {
    // Same size twice is not ambiguity, so this still proposes.
    expect(
      proposeSizeFromTitle("Olive Oil 750 ml — Extra Virgin, 750 ml bottle")
        ?.amount,
    ).toEqual({ value: 750, unit: "ml" });
  });

  it("prefers fl oz over bare oz", () => {
    // Volume, not weight — the alternation order is load-bearing.
    const proposal = proposeSizeFromTitle("Sparkling Water, 12 fl oz");
    expect(proposal?.amount.value).toBe(12);
    expect(proposal?.amount.unit).not.toBe("oz");
  });

  it("returns null for a title with no size at all", () => {
    // PRD-MVGP. The detector is silent on ~480 food products like this by
    // construction, and that is correct — nothing establishes its bag size.
    expect(proposeSizeFromTitle("Bagged Yellow Onions")).toBeNull();
    expect(proposeSizeFromTitle("")).toBeNull();
  });

  /**
   * Every case here is a REAL catalog title that the first version of this
   * parser got wrong. They were found by running it over the live corpus rather
   * than by imagining failure modes — the hand-written fixtures above were all
   * too clean to catch any of them.
   */
  describe("regressions found against the real catalog", () => {
    it("does not read the 10G in an ethernet cable as 10 grams", () => {
      expect(
        proposeSizeFromTitle(
          "Monoprice Cat6 Ethernet Bulk Cable - Stranded, 550Mhz, 10G, UTP, CM, 24AWG, Pull Box, 250 Feet, Blue",
        ),
      ).toBeNull();
    });

    it("still reads a lowercase bare gram unit", () => {
      // The 10G fix must not cost us the legitimate case.
      expect(proposeSizeFromTitle("Bulk Spice, 500 g")?.amount).toEqual({
        value: 500,
        unit: "g",
      });
    });

    it("treats a serving count as a pack marker", () => {
      // 5 g is per SERVING; the tub holds 30 of them.
      expect(
        proposeSizeFromTitle(
          "ProMix Nutrition Creatine Monohydrate Travel Packs, 5g (30 Servings)",
        ),
      ).toBeNull();
    });

    it("refuses a fraction rather than reading its denominator", () => {
      // "1/2 Pint" must not become 2 pints — 4x the real size.
      expect(proposeSizeFromTitle("Dap DryDex Spackling, 1/2 Pint")).toBeNull();
    });

    it("refuses a size that describes what the product FITS", () => {
      expect(
        proposeSizeFromTitle("EZPB Peanut Butter Stirrer (Fits 26-30oz Jars)"),
      ).toBeNull();
    });

    it("refuses units the grammar cannot round-trip", () => {
      // `parse_amount("1 qt")` returns `1 whole`, kind `other:whole` — the unit
      // is silently discarded. Proposing "1 each = 1 whole" for a quart of
      // sealer would be worse than proposing nothing. Same for `pt`.
      expect(proposeSizeFromTitle("511 Porous Plus Sealer, 1 qt")).toBeNull();
      expect(
        proposeSizeFromTitle("Straus Organic Vanilla Ice Cream, 1 pt"),
      ).toBeNull();
      // Spelled out, `quart` is a real volume and does flow through.
      expect(proposeSizeFromTitle("Paint Sample, 1 quart")?.amount).toEqual({
        value: 1,
        unit: "quart",
      });
    });

    it("still reads the plain cases the corpus is mostly made of", () => {
      expect(
        proposeSizeFromTitle(
          "365 by Whole Foods Market Mediterranean Extra Virgin Olive Oil, 33.8 fl oz",
        )?.amount.value,
      ).toBe(33.8);
      expect(
        proposeSizeFromTitle("Line 39 Sauvignon Blanc, 750 mL")?.amount,
      ).toEqual({ value: 750, unit: "ml" });
      // "16/20" is a shrimp count, not a size; only "12 oz" is a real token.
      expect(
        proposeSizeFromTitle("Whole Catch Wild Key West Shrimp 16/20, 12 oz")
          ?.amount,
      ).toEqual({ value: 12, unit: "oz" });
    });
  });

  it("never throws on arbitrary catalog text", () => {
    // A detector that can throw takes the whole Problems page down.
    for (const title of [
      "48-22-8901-X3",
      "1-2-3",
      "Ø35 22 System Router Template",
      "100% cotton, 0 oz",
      "Milwaukee 2x 0.5 kg",
      "———",
    ]) {
      expect(() => proposeSizeFromTitle(title)).not.toThrow();
    }
  });
});
