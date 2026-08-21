import { describe, expect, it } from "vitest";
import { proposeSizeFromTitle, sizeUnitAlternation } from "./title-unit-size";

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
      // "1/2 Pint" must not become 2 pints — 4x the real size. (`pint` is no
      // longer even in the vocabulary, so this one now stops one step earlier;
      // the second case keeps the fraction guard itself covered with a unit the
      // grammar DOES know, where reading the denominator would mean 2 oz for a
      // half-ounce tube.)
      expect(proposeSizeFromTitle("Dap DryDex Spackling, 1/2 Pint")).toBeNull();
      expect(proposeSizeFromTitle("Gorilla Super Glue Gel, 1/2 oz")).toBeNull();
    });

    it("refuses a size that describes what the product FITS", () => {
      expect(
        proposeSizeFromTitle("EZPB Peanut Butter Stirrer (Fits 26-30oz Jars)"),
      ).toBeNull();
    });

    /**
     * Found by the dry run when the vocabulary moved from a hand-written list
     * to the grammar's own: the grammar is a RECIPE grammar, so widening to all
     * of it admitted cooking measures that mean something else on a package.
     * None of these were reachable before, and all are live catalog titles.
     */
    describe("units that mean something else in a product title", () => {
      it("does not read a part number's trailing q as quarts", () => {
        // 13,155 quarts of router bit. The 10G ethernet bug's twin, and the
        // reason single-letter units are never admitted casually.
        expect(
          proposeSizeFromTitle(
            "Yonico Cove Router Bits Edge Forming 1/2-Inch Radius 1/4-Inch Shank 13155q",
          ),
        ).toBeNull();
      });

      it.each([
        // A cavity count, not a volume.
        "Amazon Basics Nonstick Muffin Pan, Set of 2, 12 Cups, Gray",
        // What it treats, not what it contains.
        "FryAway Cooking Oil Solidifier Powder (Solidifies 20 Cups)",
        // A vessel's capacity is not a quantity you bought.
        "Breville Sous Chef 16 Cup Food Processor",
        "Brita 10 Cup Everyday Water Pitcher with Filter, White",
      ])("refuses cups in %s", (title) => {
        expect(proposeSizeFromTitle(title)).toBeNull();
      });
    });

    describe("a range of sizes is not a size", () => {
      it.each([
        // The quarts belong to the container the lid fits.
        "Rubbermaid Commercial 6-8 Quart Lid (Yellow)",
        // The litres belong to the backpack the cover fits.
        "Joy Walker Backpack Rain Cover, 40-55L",
        // The gallons belong to the vacuum, not the filter.
        "Genuine General Debris Pleated Shop Vacuum Filter Replacement for Most 5-16 Gal. RIDGID Wet Dry Vacs",
      ])("refuses %s", (title) => {
        expect(proposeSizeFromTitle(title)).toBeNull();
      });

      it("does not mistake an em-dash for a range", () => {
        // The first cut of the range guard accepted any dash and lost this
        // one-gallon plant to the "12949 — 1 gal" it read as a span.
        expect(
          proposeSizeFromTitle(
            "Salvia leucantha 'Santa Barbara' PP#12949 — 1 gal",
          )?.amount,
        ).toEqual({ value: 1, unit: "gallon" });
      });
    });

    it("refuses units the grammar cannot round-trip", () => {
      // `parse_amount("1 qt")` returns `1 whole`, kind `other:whole` — the unit
      // is silently discarded, and proposing "1 each = 1 whole" for a quart of
      // sealer would be worse than proposing nothing. Same for `pt`.
      //
      // These are refused by the VOCABULARY now rather than by the kind gate:
      // `size_unit_aliases()` drops any spelling `Unit::from_str` cannot place
      // in a weight or volume, so `qt` and `pt` never become candidates. The
      // outcome is what it always was; what changed is that no list on this
      // side has to know about them.
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
      // Interpolated into `sql.raw` by `findProductsWithoutUnitMappings`, so a
      // metacharacter arriving from the WASM side would be a broken predicate
      // at best. Aliases are `[a-z ]` — assert that rather than trust it.
      const alternation = sizeUnitAlternation();
      expect(alternation).not.toBe("");
      for (const alias of alternation.split("|")) {
        expect(alias).toMatch(/^[a-z ]+$/);
      }
    });

    it("orders the alternation longest-first", () => {
      // Order IS semantics in an alternation: with "oz" first, "12 fl oz"
      // matches the bare ounce and the proposal comes out a weight. Rust sorts
      // it; this is the assertion that the sorted order survives the crossing.
      const aliases = sizeUnitAlternation().split("|");
      expect(aliases.indexOf("fl oz")).toBeLessThan(aliases.indexOf("oz"));
      expect(aliases.indexOf("ounces")).toBeLessThan(aliases.indexOf("ounce"));
    });

    it("pins every recipe-measure exclusion to a real alias", () => {
      // The exclusions are the one hand-written thing left, so they are checked
      // against the derived vocabulary: an entry that no longer names a real
      // alias is a silent no-op, and the next person reads it as protection
      // that isn't there.
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
        expect(aliases.has(stem), stem).toBe(true);
      }
    });

    it("keeps the SQL alternation a superset of what the matcher accepts", () => {
      // The structural guarantee: SQL matches the whole vocabulary
      // case-insensitively, the matcher only ever narrows it. Proven against
      // real Postgres in detectors-title-size.integration.test.ts; checked here
      // on the shape, so a change is caught without a database.
      const alternation = sizeUnitAlternation();
      const sqlLike = new RegExp(`[0-9][ ]?(?:${alternation})\\b`, "i");
      for (const title of [
        "Bagged Yellow Onions, 32 OZ",
        "Bag of Sugar, 5 pounds",
        "Bulk Spice, 500 g",
        "Sparkling Water, 12 fl oz",
        "Paint Sample, 1 quart",
      ]) {
        expect(proposeSizeFromTitle(title), title).not.toBeNull();
        expect(sqlLike.test(title), title).toBe(true);
      }
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
