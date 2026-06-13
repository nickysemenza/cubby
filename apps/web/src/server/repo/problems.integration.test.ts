import type { ActorContext } from "@cubby/schemas/context";
import { eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { createIngredient, getIngredientByName } from "./ingredient";
import { findAllProblems, reparseStaleIngredientParses } from "./problems";
import { createProduct } from "./product";
import { createRecipe } from "./recipe";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";

// Repo-layer tests for the WASM-driven, highest-logic problem scans. The private
// find* helpers are exercised through the public findAllProblems aggregator;
// reparseStaleIngredientParses is called directly.

describe("problems repo", () => {
  let db: Database;
  let actor: ActorContext;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, actor, teardown } = await buildTestDB());
    return teardown;
  });

  // A recipe whose single ingredient row stores `amounts`/`rawLine`; a mismatch
  // between rawLine's fresh parse and the stored amounts is parse drift.
  const recipeWithRow = (
    name: string,
    ingredientId: string,
    opts: { amounts: { value: number; unit: string }[]; rawLine: string },
  ) =>
    createRecipe(
      db,
      makeRecipeInput({
        name,
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(ingredientId, opts)],
          },
        ],
      }),
      actor,
    );

  describe("findStaleIngredientParses", () => {
    it("flags a row whose stored parse drifted and leaves a matching row alone", async () => {
      const flour = await createIngredient(
        db,
        { name: "flour", aliases: [] },
        actor,
      );

      // Drift: rawLine parses to 2 cup, but 99 cup is stored.
      const drifted = await recipeWithRow("Drifted", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });
      // No drift: stored amounts match the fresh parse.
      const clean = await recipeWithRow("Clean", flour.id, {
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups flour",
      });

      const { staleIngredientParses } = await findAllProblems(db);
      const driftedEntry = staleIngredientParses.find(
        (s) => s.recipeId === drifted.id,
      );
      expect(driftedEntry).toBeDefined();
      expect(driftedEntry?.amountDrift).toBe(true);
      expect(driftedEntry?.nameDrift).toBe(false);
      expect(staleIngredientParses.some((s) => s.recipeId === clean.id)).toBe(
        false,
      );
    });
  });

  describe("reparseStaleIngredientParses", () => {
    it("re-parses drifted amounts, marks the recipe affected, and is idempotent", async () => {
      const flour = await createIngredient(
        db,
        { name: "flour", aliases: [] },
        actor,
      );
      const recipe = await recipeWithRow("Reparse", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });

      const result = await reparseStaleIngredientParses(db);
      expect(result.updated).toBeGreaterThanOrEqual(1);
      expect(result.recipesAffected).toContain(recipe.id);

      // The drift is gone, and a second run finds nothing.
      const { staleIngredientParses } = await findAllProblems(db);
      expect(staleIngredientParses.some((s) => s.recipeId === recipe.id)).toBe(
        false,
      );
      expect((await reparseStaleIngredientParses(db)).updated).toBe(0);
    });

    it("find-or-creates the ingredient when the parsed name drifted", async () => {
      // Stored name "flour" but the raw line parses to "sugar" → name drift.
      const flour = await createIngredient(
        db,
        { name: "flour", aliases: [] },
        actor,
      );
      await recipeWithRow("NameDrift", flour.id, {
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups sugar",
      });

      await reparseStaleIngredientParses(db);
      // The re-parse find-or-created the drifted-to ingredient.
      expect(await getIngredientByName(db, "sugar")).not.toBeNull();
    });
  });

  describe("findInvalidUPCs", () => {
    it("flags an invalid-format UPC and leaves a valid one clean", async () => {
      // Seed an invalid UPC by writing it past the input schema (which would
      // reject it) — the scan exists precisely for rows the schema can't catch.
      const bad = await createProduct(
        db,
        makeProductInput({ name: "Bad UPC Product" }),
        actor,
      );
      await getDb(db)
        .update(product)
        .set({ upc: "123" }) // too short for UPC-A (min 12)
        .where(eq(product.id, bad.id));

      const good = await createProduct(
        db,
        makeProductInput({ name: "Good UPC Product", upc: "012345678905" }),
        actor,
      );

      const { invalidUPCs } = await findAllProblems(db);
      const flagged = invalidUPCs.find((u) => u.id === bad.id);
      expect(flagged?.issue).toBe("invalid_format");
      expect(invalidUPCs.some((u) => u.id === good.id)).toBe(false);
      // NB: the duplicate-UPC sub-case can't be seeded — a partial unique index
      // (Product_upc_key WHERE deletedAt IS NULL) bars two live products sharing
      // a UPC, so the Map-based dedup in findInvalidUPCs is purely defensive.
    });
  });

  describe("findProductsWithIslandedMappings", () => {
    it("flags a product whose mappings form 2+ islands but not a connected one", async () => {
      // widget↔gadget are custom units unreachable from the standard unit graph,
      // so they island off from cup↔g.
      const islanded = await createProduct(
        db,
        makeProductInput({
          name: "Islanded Product",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
            {
              a: { value: 1, unit: "widget" },
              b: { value: 3, unit: "gadget" },
              source: null,
            },
          ],
        }),
        actor,
      );
      // cup↔g and tsp↔ml all sit in the one connected standard graph.
      const connected = await createProduct(
        db,
        makeProductInput({
          name: "Connected Product",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
            {
              a: { value: 1, unit: "tsp" },
              b: { value: 5, unit: "ml" },
              source: null,
            },
          ],
        }),
        actor,
      );

      const { productsWithIslandedMappings } = await findAllProblems(db);
      const flagged = productsWithIslandedMappings.find(
        (p) => p.id === islanded.id,
      );
      expect(flagged).toBeDefined();
      expect(flagged!.islandCount).toBeGreaterThanOrEqual(2);
      expect(
        productsWithIslandedMappings.some((p) => p.id === connected.id),
      ).toBe(false);
    });
  });
});
