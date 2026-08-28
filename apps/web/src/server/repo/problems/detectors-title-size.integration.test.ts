import type { ProductCreateInput } from "@cubby/schemas/product";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { proposeSizeFromTitle } from "~/lib/title-unit-size";
import { findProductsWithoutUnitMappings } from "~/server/repo/problems";
import { createProduct } from "~/server/repo/product";
import { makeProductInput } from "~/server/repo/repo.fixtures";

/**
 * The repo half of the title-size proposals: a DB-narrowed shortlist that must
 * stay a strict SUPERSET of what `proposeSizeFromTitle` accepts.
 *
 * That superset property is the only correctness requirement on the SQL — it
 * exists to stop ~5,500 mapping-less products crossing into JS to be parsed
 * (the row-marshalling shape behind the parse-sweep CPU incident), not to
 * decide anything. Narrowing it silently hides candidates, which is why the
 * last case here asserts the two halves agree.
 */
describe("findProductsWithoutUnitMappings", () => {
  const ctx = withTestDb();

  const seed = (
    name: string,
    overrides: Omit<Partial<ProductCreateInput>, "ingredientId"> = {},
  ) =>
    createProduct(ctx.db, makeProductInput({ name, ...overrides }), TEST_ACTOR);

  const names = async () =>
    (await findProductsWithoutUnitMappings(ctx.db)).map((row) => row.name);

  it("shortlists a mapping-less product whose title states a size", async () => {
    await seed("Shortlist Me Bagged Onions, 32 OZ", { model: "TS-1" });
    expect(await names()).toContain("Shortlist Me Bagged Onions, 32 OZ");
  });

  it("skips a product that already has a conversion", async () => {
    await seed("Already Mapped Olive Oil, 750 ml", {
      model: "TS-2",
      unitMappings: [
        {
          a: { value: 1, unit: "each" },
          b: { value: 750, unit: "ml" },
          source: null,
        },
      ],
    });
    expect(await names()).not.toContain("Already Mapped Olive Oil, 750 ml");
  });

  it("skips a title with no size at all", async () => {
    await seed("Unsized Bagged Onions", { model: "TS-3" });
    expect(await names()).not.toContain("Unsized Bagged Onions");
  });

  it("still shortlists rows the parser will go on to REJECT", async () => {
    // The SQL deliberately does not know about pack counts — refusing those is
    // the parser's job, and duplicating the rule in SQL would let the two
    // drift. This asserts the split, not just the outcome.
    const packName = "Shortlisted Sparkling Water, 12-pack, 12 fl oz";
    await seed(packName, { model: "TS-4" });
    expect(await names()).toContain(packName);
    expect(proposeSizeFromTitle(packName)).toBeNull();
  });

  it("shortlists everything the parser accepts, including PLURAL units", async () => {
    // The superset property. Regression: the SQL used to carry its own
    // hand-written unit list with only SINGULAR spellings, and Postgres's `\M`
    // word-end anchor then rejected "5 pounds" on the trailing "s" — the parser
    // accepted those titles but they never arrived. Both sides now build from
    // one exported alternation, and this checks the property rather than the
    // spelling, so a future edit to either can't quietly reintroduce it.
    const accepted = [
      "Superset Check Flour, 44 oz",
      "Superset Check Syrup, 12 fl oz",
      "Superset Check Spice, 500 g",
      "Superset Check Paint, 1 quart",
      // The plurals the old SQL dropped:
      "Superset Check Sugar, 5 pounds",
      "Superset Check Cheese, 8 ounces",
      "Superset Check Juice, 3 liters",
      "Superset Check Oil, 2 gallons",
      "Superset Check Bulk, 750 grams",
      "Superset Check Thinner, 4 quarts",
      "Superset Check Rice, 3 lbs",
      // The whitespace the SQL used to get wrong. The matcher separates digits
      // from unit with `\s*` — any run of any whitespace — while the predicate
      // was written `[ ]?`, exactly one optional literal space. Both of these
      // parsed fine and were never shortlisted.
      "Superset Check Sugar, 5  lb",
      "Superset Check Salt,\t2 kg",
      "Superset Check Beans, 3lb",
    ];
    for (const [index, name] of accepted.entries()) {
      await seed(name, { model: `TS-SUP-${index}` });
    }

    const shortlisted = new Set(await names());
    for (const name of accepted) {
      // Guard the guard: if the parser stops accepting one of these the case
      // would pass vacuously and stop testing the superset at all.
      expect(proposeSizeFromTitle(name)).not.toBeNull();
      expect(shortlisted.has(name)).toBe(true);
    }
  });
});
