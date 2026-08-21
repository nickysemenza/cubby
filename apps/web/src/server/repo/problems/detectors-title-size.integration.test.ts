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

  it("shortlists everything the parser accepts", async () => {
    // The superset property, checked over whatever the DB actually holds: a row
    // the parser would accept must never be missing from the shortlist.
    const shortlisted = new Set(await names());
    const accepted = [
      "Superset Check Flour, 44 oz",
      "Superset Check Syrup, 12 fl oz",
      "Superset Check Spice, 500 g",
      "Superset Check Paint, 1 quart",
    ];
    for (const [index, name] of accepted.entries()) {
      await seed(name, { model: `TS-SUP-${index}` });
    }
    const after = new Set(await names());
    for (const name of accepted) {
      expect(proposeSizeFromTitle(name)).not.toBeNull();
      expect(after.has(name)).toBe(true);
    }
    expect(shortlisted.size).toBeLessThan(after.size);
  });
});
