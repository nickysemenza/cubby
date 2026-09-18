import { describe, expect, it } from "vitest";

import { proposeSizeFromTitle, sizeUnitAlternation } from "./title-unit-size";

/**
 * Runs against the real `parse_amount` grammar, not a stub — the whole design
 * is that Rust owns the parsing and the TS regex only locates a candidate.
 *
 * Fixtures are placeholders per AGENTS.md, but they are not invented: each one
 * reproduces the exact STRING SHAPE of a title that broke this parser (a "10G",
 * a trailing "13155q", an em-dash before a size), with brands and any observed
 * price removed. The shape is what the regression is about; the vendor is not,
 * and neither belongs in a public fixture. Reproducing the shapes matters
 * because hand-imagined titles are systematically too clean — none of the cases
 * in the last block below were caught by the tidy fixtures above them.
 */
describe("proposeSizeFromTitle", () => {
  it("proposes the pack size when the title states exactly one", () => {
    const proposal = proposeSizeFromTitle("Bagged Yellow Onions, 32 OZ");
    expect(proposal?.amount).toEqual({ value: 32, unit: "oz" });
    expect(proposal?.token).toBe("32 OZ");
  });

  it.each([
    ["15 oz. Fluorescent Red-Orange 2X Marking Spray Paint", 15, "oz"],
    ["Brushing Lacquer Aerosol Semi-Gloss Clear 12 oz.", 12, "oz"],
    ["Laundry Detergent, Free & Clear, 40 oz", 40, "oz"],
    ["Whole Milk, 1 gal", 1, "gallon"],
    ["Isomalt Crystals, 2 lb", 2, "lb"],
  ])("reads %s", (title, value, unit) => {
    expect(proposeSizeFromTitle(title)?.amount).toEqual({ value, unit });
  });

  describe("refuses anything carrying a pack count", () => {
    it.each([
      "Grapefruit Sparkling Water, 12-pack, 12 fl oz",
      "Unsweetened Almond Barista Blend Almond Milk, 32 Oz (Pack Of 6)",
      "Strawberry Fruit Chews, 1.76 oz (Pack of 10)",
      "Ready Rice Whole Grain Brown Rice, 8.8oz (12-Pack)",
      "272479-6PK Spray Primer 1-2-3 Plus, 13 oz, White, 6 Pack",
      "Swedish Sour Peach Fish Candy, 5.2oz (2-Pack)",
      "Clear PET Spray Bottles, 2 oz, 10-Pack",
      "Frozen Snack Bites, 14 oz, 4-Count",
      "Glass Bowls, 7 oz, Set of 4",
      "Fruit Candy, 10.5 oz, 24 Snack Packs",
    ])("refuses %s", (title) => {
      expect(proposeSizeFromTitle(title)).toBeNull();
    });

    it("refuses even when the size IS the total, because the title can't say so", () => {
      expect(
        proposeSizeFromTitle(
          "Original Petite Dog Dental Treats (27 oz, 45 ct)",
        ),
      ).toBeNull();
    });

    it("refuses a bare N x SIZE multiplier", () => {
      // PACK_MARKER only knows the WORDS pack/pk/ct/count/servings, and the
      // distinct-size guard cannot help either: the multiplier carries no unit,
      // so exactly one size token is found and the title looks unambiguous.
      // Left alone this proposed `1 each = 16 oz` for a 48 oz trio.
      expect(
        proposeSizeFromTitle(
          "Liquid Nutrient Trio: Bloom, Grow, Tiger (3x16 oz)",
        ),
      ).toBeNull();
      expect(proposeSizeFromTitle("Protein Bars, 12 x 1.4 oz")).toBeNull();
      expect(proposeSizeFromTitle("Protein Bars, 12 × 1.4 oz")).toBeNull();
    });

    it("keeps a proposal when the x is a DIMENSION, not a count", () => {
      // Why the multiplier test is anchored to the token rather than run over
      // the whole title: a title-wide version refused 14 correct proposals on
      // the live catalog, because most x's in a hardware title describe the
      // part. Here the pound is the box, and the `#10 x 3-1/2 in.` is the screw.
      expect(
        proposeSizeFromTitle(
          "#10 x 3-1/2 in. Star Drive Flat Head Construction Screws 1 lb. Box",
        )?.amount,
      ).toEqual({ value: 1, unit: "lb" });
    });
  });

  it("refuses a dimension rather than a pack size", () => {
    expect(
      proposeSizeFromTitle("12 in. Pry Bar and 9 in. Nail Puller"),
    ).toBeNull();
    expect(
      proposeSizeFromTitle("48 in. W Garage Wall Storage Track Channel"),
    ).toBeNull();
  });

  it("refuses when two different sizes appear", () => {
    expect(
      proposeSizeFromTitle("Sanding Belts 2x42 Inch, 5 lb and 2 lb assortment"),
    ).toBeNull();
  });

  it("collapses a size repeated in the same title", () => {
    expect(
      proposeSizeFromTitle("Olive Oil 750 ml — Extra Virgin, 750 ml bottle")
        ?.amount,
    ).toEqual({ value: 750, unit: "ml" });
  });

  it("prefers fl oz over bare oz", () => {
    const proposal = proposeSizeFromTitle("Sparkling Water, 12 fl oz");
    expect(proposal?.amount.value).toBe(12);
    expect(proposal?.amount.unit).not.toBe("oz");
  });

  it("returns null for a title with no size at all", () => {
    expect(proposeSizeFromTitle("Bagged Yellow Onions")).toBeNull();
    expect(proposeSizeFromTitle("")).toBeNull();
  });

  /**
   * Every case here reproduces a catalog title shape that the first version of
   * this parser got wrong. They were found by running it over the live corpus
   * rather than by imagining failure modes — the tidier fixtures above caught
   * none of them.
   */
  describe("regressions found against the real catalog", () => {
    it("does not read the 10G in an ethernet cable as 10 grams", () => {
      expect(
        proposeSizeFromTitle(
          "Cat6 Ethernet Bulk Cable - Stranded, 550Mhz, 10G, UTP, CM, 24AWG, Pull Box, 250 Feet, Blue",
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
      expect(
        proposeSizeFromTitle(
          "Creatine Monohydrate Travel Packs, 5g (30 Servings)",
        ),
      ).toBeNull();
    });

    it("refuses a fraction rather than reading its denominator", () => {
      // "1/2 Pint" must not become 2 pints — 4x the real size. (`pint` is no
      // longer even in the vocabulary, so this one now stops one step earlier;
      // the second case keeps the fraction guard itself covered with a unit the
      // grammar DOES know, where reading the denominator would mean 2 oz for a
      // half-ounce tube.)
      expect(proposeSizeFromTitle("Spackling Compound, 1/2 Pint")).toBeNull();
      expect(proposeSizeFromTitle("Super Glue Gel, 1/2 oz")).toBeNull();
    });

    it("refuses a size that describes what the product FITS", () => {
      expect(
        proposeSizeFromTitle("Peanut Butter Stirrer (Fits 26-30oz Jars)"),
      ).toBeNull();
    });

    /**
     * Found by the dry run when the vocabulary moved from a hand-written list
     * to the grammar's own: the grammar is a RECIPE grammar, so widening to all
     * of it admitted cooking measures that mean something else on a package.
     * None of these were reachable before.
     */
    describe("units that mean something else in a product title", () => {
      it("does not read a part number's trailing q as quarts", () => {
        // 13,155 quarts of router bit. The 10G bug's twin, and the reason
        // single-letter units are never admitted casually.
        expect(
          proposeSizeFromTitle(
            "Cove Router Bit Edge Forming 1/2-Inch Radius 1/4-Inch Shank 13155q",
          ),
        ).toBeNull();
      });

      it.each([
        "Nonstick Muffin Pan, Set of 2, 12 Cups, Gray",
        "Cooking Oil Solidifier Powder (Solidifies 20 Cups)",
        // A vessel's capacity is not a quantity you bought.
        "Sous Chef 16 Cup Food Processor",
        "10 Cup Everyday Water Pitcher with Filter, White",
      ])("refuses cups in %s", (title) => {
        expect(proposeSizeFromTitle(title)).toBeNull();
      });
    });

    describe("a range of sizes is not a size", () => {
      it.each([
        "Commercial 6-8 Quart Lid (Yellow)",
        "Backpack Rain Cover, 40-55L",
        // The gallons belong to the vacuum, not the filter. Worded to avoid
        // "replacement for", so only the range guard can refuse this one.
        "General Debris Pleated Shop Vacuum Filter for Most 5-16 Gal. Wet Dry Vacs",
      ])("refuses %s", (title) => {
        expect(proposeSizeFromTitle(title)).toBeNull();
      });

      it("does not mistake an em-dash for a range", () => {
        // The first cut of the range guard accepted any dash and lost this
        // one-gallon plant to the "12949 — 1 gal" it read as a span.
        expect(
          proposeSizeFromTitle("Nursery Perennial PP#12949 — 1 gal")?.amount,
        ).toEqual({ value: 1, unit: "gallon" });
      });
    });

    describe("capacity and compatibility are not purchased quantity", () => {
      it.each([
        "Four Step Ladder with Tool Tray, Lightweight 330 lbs Portable Steel Step Stool",
        "Utility Chain, 1/8 in. x 33 ft., 350 lbs Safe Working Load",
        "Heavy Duty 5 gal. Metal Bucket Grid",
        "Steel Paddle Mixer, Ideal Mixing Tool for 5 Gallon Bucket",
        "Heavy Duty Plate Casters with Brakes, 500Lbs",
        "Moving Straps, Carry Furniture Up to 800 lbs Safely",
        "Handheld Camera Stabilizer, 5.5 lb Payload",
        "Compact 12 gal. Shopvac",
        "Cordless 2.5 Gallon Wet/Dry Vacuum",
        "7 Gal. Tough Storage Tote",
        "Insulated Water Bottle, 16.9 oz",
        "20 oz Insulated Tumbler",
        "Insulated Tumbler with Lid and Straw, 24 oz",
        "Insulated Travel Tumbler with Straw, 24 oz",
      ])("refuses %s", (title) => {
        expect(proposeSizeFromTitle(title)).toBeNull();
      });

      it.each([
        ["Interior Wall Paint, 1 gal", 1, "gallon"],
        ["Lightweight Spackling Filler, 32 oz Tub", 32, "oz"],
      ])("keeps the purchased quantity in %s", (title, value, unit) => {
        expect(proposeSizeFromTitle(title)?.amount).toEqual({ value, unit });
      });
    });
  });

  /**
   * The vocabulary is not written here — `wasm.size_unit_aliases()` filters
   * candidate spellings through `Unit::from_str` + `kind()` and hands back what
   * survives. These pin the properties this module depends on, so a change on
   * the Rust side that would quietly narrow the matcher fails here instead of
   * in production, where a narrowed vocabulary just looks like titles nobody
   * proposed a size for.
   */
  describe("vocabulary derived from the grammar", () => {
    // The reviewer's bug on PR #842, from the other side: the SQL prefilter
    // listed singular spellings only. Both halves now come from one call, so
    // the plural forms exist because `strip_plural` says they do.
    it.each([
      ["Bag of Sugar, 5 pounds", 5, "lb"],
      ["Block Cheese, 8 ounces", 8, "oz"],
      ["Apple Juice, 3 liters", 3, "l"],
      ["Paint Thinner, 2 gallons", 2, "gallon"],
      ["Bulk Rice, 3 lbs", 3, "lb"],
      ["Spice Jar, 750 grams", 750, "g"],
      ["Mineral Spirits, 4 quarts", 4, "quart"],
    ])("reads the plural spelling in %s", (title, value, unit) => {
      expect(proposeSizeFromTitle(title)?.amount).toEqual({ value, unit });
    });

    it("hands Postgres an alternation it can run verbatim", () => {
      const alternation = sizeUnitAlternation();
      expect(alternation).not.toBe("");
      for (const alias of alternation.split("|")) {
        expect(alias).toMatch(/^[a-z ]+$/);
      }
    });

    it("orders the alternation longest-first", () => {
      const aliases = sizeUnitAlternation().split("|");
      expect(aliases.indexOf("fl oz")).toBeLessThan(aliases.indexOf("oz"));
      expect(aliases.indexOf("ounces")).toBeLessThan(aliases.indexOf("ounce"));
    });

    it("pins every recipe-measure exclusion to a real alias", () => {
      const aliases = new Set(sizeUnitAlternation().split("|"));
      for (const stem of [
        "c",
        "cup",
        "q",
        "tsp",
        "teaspoon",
        "tbsp",
        "tablespoon",
      ]) {
        // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
        expect(aliases.has(stem), stem).toBe(true);
      }
    });

    it("keeps the SQL alternation a superset of what the matcher accepts", () => {
      // The structural guarantee: SQL matches the whole vocabulary
      // case-insensitively, the matcher only ever narrows it. Proven against
      // real Postgres in detectors-title-size.integration.test.ts; checked here
      // on the shape, so a change is caught without a database.
      //
      // ⚠️ The separator must be `[[:space:]]*` / `\s*`, mirroring the matcher.
      // A prefilter written `[ ]?` (one literal space) accepted none of the
      // whitespace cases below, so those titles parsed fine and were never
      // shortlisted — silently unproposable.
      const alternation = sizeUnitAlternation();
      const sqlLike = new RegExp(`[0-9]\\s*(?:${alternation})\\b`, "i");
      for (const title of [
        "Bagged Yellow Onions, 32 OZ",
        "Bag of Sugar, 5 pounds",
        "Bulk Spice, 500 g",
        "Sparkling Water, 12 fl oz",
        "Paint Sample, 1 quart",
        "Bag of Sugar, 5  lb",
        "Bag of Sugar, 5\tlb",
        "Bag of Sugar, 5lb",
      ]) {
        // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
        expect(proposeSizeFromTitle(title), title).not.toBeNull();
        // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
        expect(sqlLike.test(title), title).toBe(true);
      }
    });
  });

  it("never throws on arbitrary catalog text", () => {
    // A detector that can throw takes the whole Problems page down.
    for (const title of [
      "12-34-5678-X9",
      "1-2-3",
      "Ø35 22 System Router Template",
      "100% cotton, 0 oz",
      "Cordless Tool 2x 0.5 kg",
      "———",
    ]) {
      expect(() => proposeSizeFromTitle(title)).not.toThrow();
    }
  });
});
