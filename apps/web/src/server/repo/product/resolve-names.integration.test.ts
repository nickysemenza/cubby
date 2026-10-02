import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  createIngredientFixture,
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocument } from "~/server/repo/search-document";

import { resolveProductNames } from "./resolve-names";

const resolveByName = (db: Database, names: string[]) =>
  resolveProductNames(db, { names });

describe("resolveProductNames", () => {
  const ctx = withTestDb();

  it("resolves a line's external ids, ingredient aliases, and lexical candidates in one call", async () => {
    const fresh = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic Oat Drink 1 L",
        externalIds: [
          {
            source: "amazon-fresh",
            kind: "asin",
            externalId: "B0SYNTH777",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const other = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic Rice Cooker",
        externalIds: [
          {
            source: "whole-foods",
            kind: "asin",
            externalId: "B0SYNTH888",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const lexical = await createProduct(
      ctx.db,
      makeProductInput({ name: "Zucchini Noodles Spiralized" }),
      ctx.actor,
    );
    const flour = await createIngredientFixture(
      ctx.db,
      { name: "All-purpose flour", aliases: ["AP flour"] },
      ctx.actor,
    );

    const results = await resolveProductNames(ctx.db, {
      lines: [
        {
          name: "Totally Different Receipt Wording",
          externalIds: [
            // Same ASIN under a source that does not hold it: no hit there.
            { source: "amazon", id: "B0SYNTH777" },
            { source: "amazon-fresh", id: "B0SYNTH777" },
            { source: "whole-foods", id: "B0SYNTH888" },
          ],
        },
        { name: "ap flour" },
        { name: "zucchini" },
        { name: "Nothing Like This Exists", externalIds: [] },
      ],
    });

    expect(results.map((r) => r.name)).toEqual([
      "Totally Different Receipt Wording",
      "ap flour",
      "zucchini",
      "Nothing Like This Exists",
    ]);
    expect(results[0]?.exactIdHits.map((p) => p.id).sort()).toEqual(
      [fresh.id, other.id].sort(),
    );
    expect(results[0]?.ingredientHits).toEqual([]);
    expect(results[1]).toMatchObject({
      exactIdHits: [],
      exact: false,
      ingredientHits: [{ id: flour.id, name: "All-purpose flour" }],
    });
    expect(results[2]?.candidates.map((c) => c.id)).toEqual([lexical.id]);
    expect(results[3]).toMatchObject({
      exactIdHits: [],
      ingredientHits: [],
      candidates: [],
    });
  });

  it("keeps names and lines separate: each requested line answers once", async () => {
    const results = await resolveProductNames(ctx.db, {
      names: ["Same Name", "same name"],
      lines: [{ name: "Same Name" }, { name: "Same Name" }],
    });
    expect(results.map((r) => r.name)).toEqual([
      "Same Name",
      "Same Name",
      "Same Name",
    ]);
  });

  it("matches names and aliases exactly, falls back to a contains search, and never creates", async () => {
    const soy = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Lee Kum Kee Premium Soy Sauce, 500 ml",
        aliases: ["LKK Soy Sauce 500ml"],
      }),
      ctx.actor,
    );
    const coconut = await createProduct(
      ctx.db,
      makeProductInput({ name: "Aroy-D Coconut Milk, 14 oz" }),
      ctx.actor,
    );

    const results = await resolveByName(ctx.db, [
      "  lkk soy sauce 500ML ",
      "LKK Soy Sauce 500ml", // casing/whitespace twin of the line above
      "aroy-d",
      "Nothing Like This Exists",
    ]);

    expect(results).toMatchObject([
      {
        name: "lkk soy sauce 500ML",
        exact: true,
        candidates: [expect.objectContaining({ id: soy.id, name: soy.name })],
      },
      {
        name: "aroy-d",
        exact: false,
        candidates: [
          expect.objectContaining({ id: coconut.id, name: coconut.name }),
        ],
      },
      { name: "Nothing Like This Exists", exact: false, candidates: [] },
    ]);
  });

  it("gives every missed name its own name-ordered top-3 from one batched fuzzy pass", async () => {
    const widgetNames = [
      "Widget Alpha",
      "Widget Beta",
      "Widget Gamma",
      "Widget Delta",
    ];
    const widgets = new Map(
      await Promise.all(
        widgetNames.map(
          async (name) =>
            [
              name,
              await createProduct(
                ctx.db,
                makeProductInput({ name }),
                ctx.actor,
              ),
            ] as const,
        ),
      ),
    );
    const gadgetNames = ["Gadget One", "Gadget Two"];
    const gadgets = new Map(
      await Promise.all(
        gadgetNames.map(
          async (name) =>
            [
              name,
              await createProduct(
                ctx.db,
                makeProductInput({ name }),
                ctx.actor,
              ),
            ] as const,
        ),
      ),
    );
    const sprocket = await createProduct(
      ctx.db,
      makeProductInput({ name: "Sprocket Single" }),
      ctx.actor,
    );

    const results = await resolveByName(ctx.db, [
      "widget",
      "gadget",
      "sprocket",
      "Nonexistent Item Xyz",
    ]);

    expect(results).toMatchObject([
      {
        name: "widget",
        exact: false,
        // 4 products match "widget"; only the top 3 by name come back.
        candidates: ["Widget Alpha", "Widget Beta", "Widget Delta"].map(
          (name) =>
            expect.objectContaining({ id: widgets.get(name)!.id, name }),
        ),
      },
      {
        name: "gadget",
        exact: false,
        candidates: gadgetNames.map((name) =>
          expect.objectContaining({ id: gadgets.get(name)!.id, name }),
        ),
      },
      {
        name: "sprocket",
        exact: false,
        candidates: [
          expect.objectContaining({ id: sprocket.id, name: sprocket.name }),
        ],
      },
      { name: "Nonexistent Item Xyz", exact: false, candidates: [] },
    ]);
  });

  it("keeps the fuzzy pass's statement count flat as the miss count grows", async () => {
    const solo = await createProduct(
      ctx.db,
      makeProductInput({ name: "Solitary Match Product" }),
      ctx.actor,
    );

    // Same single match either way ("solitary"); the rest of the names in
    // the 10-name call have no match at all. A per-name loop would issue
    // several statements per additional name — one batched LATERAL pass plus
    // one shared hydration call should not.
    const one = await countTestDbQueries(() =>
      resolveByName(ctx.db, ["solitary"]),
    );
    const ten = await countTestDbQueries(() =>
      resolveByName(ctx.db, [
        "solitary",
        ...Array.from({ length: 9 }, (_, i) => `no-such-term-${i}`),
      ]),
    );

    expect(one.result[0]?.candidates).toEqual([
      expect.objectContaining({ id: solo.id, name: solo.name }),
    ]);
    expect(ten.queryCount).toBe(one.queryCount);
  });

  // The miss pass is the lexical engine, not a raw contains: a receipt line
  // carries words the stored name lacks and vice versa.
  describe("lexical candidates for a miss", () => {
    const indexed = async (name: string, aliases: string[] = []) => {
      const created = await createProduct(
        ctx.db,
        makeProductInput({ name, aliases }),
        ctx.actor,
      );
      await refreshSearchDocument(ctx.db, "product", created.entityId);
      return created;
    };

    it("finds a product whose whole name sits inside a longer requested name", async () => {
      const fruit = await indexed("Example Fruit");
      const [result] = await resolveByName(ctx.db, ["Organic Example Fruit"]);
      expect(result).toMatchObject({ exact: false });
      expect(result?.candidates.map((c) => c.id)).toEqual([fruit.id]);
    });

    it("ranks products covering more of the requested tokens first", async () => {
      const jam = await indexed("Example Fruit Jam Jar");
      const tea = await indexed("Organic Widget Tea");
      await indexed("Unrelated Gadget");
      const [result] = await resolveByName(ctx.db, [
        "organic example fruit spread",
      ]);
      expect(result?.candidates.map((c) => c.id)).toEqual([jam.id, tea.id]);
    });

    it("tolerates a misspelling through the trigram arm", async () => {
      const marmalade = await indexed("Marmalade");
      const [result] = await resolveByName(ctx.db, ["marmelade"]);
      expect(result?.candidates.map((c) => c.id)).toEqual([marmalade.id]);
    });

    it("offers nothing when no token or trigram overlaps", async () => {
      await indexed("Zebra Crossing Paint");
      const [result] = await resolveByName(ctx.db, ["quartz countertop"]);
      expect(result?.candidates).toEqual([]);
    });
  });
});
