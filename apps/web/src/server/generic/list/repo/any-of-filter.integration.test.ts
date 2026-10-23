import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { getDb } from "~/server/db/helpers";
import { formatSearchTerm, textArrayMatches } from "~/server/db/helpers/query";
import {
  entityLink,
  ingredient,
  location,
  product,
  project,
  recipe,
  task,
  wish,
} from "~/server/db/schema";
import { buildIngredientListWhere } from "~/server/domains/ingredient/repo/search";
import { buildLocationWhere } from "~/server/domains/location/repo/crud";
import { buildProjectWhere } from "~/server/domains/project/repo/lookup";
import { buildRecipeWhere } from "~/server/domains/recipe/repo/crud";
import { buildTaskWhere } from "~/server/domains/task/repo/lookup";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { buildWishWhere } from "~/server/domains/wish/repo";
import { linkValues } from "~/server/generic/entity-links/repo/entity-links";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

/**
 * Multi-field text filters (`anyOf`) compile from their declaration. Each
 * case runs the hand-written predicate the declaration replaced (plan rows
 * 27–29, and the `stored.columns` text searches folded into `anyOf`) beside
 * the compiled filter over the same synthetic rows, and pins both to the
 * expected rows. Failure modes: a member field is dropped from the OR; a
 * `via` member reads the stored reference instead of the inherited one, or
 * matches a soft-deleted link or record; a to-many `via` member matches
 * once per row instead of any row; a `text[]` member matches across element
 * boundaries; matching stops being case-insensitive.
 */
describe("anyOf text filters", () => {
  const ctx = withTestDb();
  const db = () => ctx.db;

  /** Codes of `rows` matching `where`, sorted. */
  const matching = async (
    table: PgTable & { id: AnyPgColumn; shortcode: AnyPgColumn },
    rows: readonly { id: string }[],
    where: SQL | undefined,
  ) =>
    (
      await getDb(db())
        .select({ code: table.shortcode })
        .from(table)
        .where(
          and(
            inArray(
              table.id,
              rows.map((row) => row.id),
            ),
            where,
          ),
        )
    )
      .map((row) => String(row.code))
      .sort();
  const codes = (...rows: { shortcode: string }[]) =>
    rows.map((row) => row.shortcode).sort();

  /**
   * Each case's rows under the old predicate and the compiled filter, beside
   * the rows both must return.
   */
  const equivalence = async (
    cases: ReadonlyArray<
      readonly [term: string, expected: string[], old: SQL | undefined]
    >,
    compiled: (term: string) => Promise<SQL | undefined> | SQL | undefined,
    table: PgTable & { id: AnyPgColumn; shortcode: AnyPgColumn },
    rows: readonly { id: string }[],
  ) => {
    const actual = [];
    for (const [term, , old] of cases)
      actual.push({
        term,
        before: await matching(table, rows, old),
        after: await matching(table, rows, await compiled(term)),
      });
    const expected = cases.map(([term, rows]) => ({
      term,
      before: rows,
      after: rows,
    }));
    return { actual, expected };
  };

  it("matches a project by name, notes, or an own or inherited location", async () => {
    const insert = (
      name: string,
      values: {
        notes?: string;
        parent?: { id: string };
        locations?: string[];
      } = {},
    ) =>
      insertWithShortcode(db(), "project", {
        name,
        notes: values.notes ?? null,
        parentProjectId: (values.parent?.id ?? null) as never,
        locationsMode: values.locations === undefined ? "inherit" : "explicit",
        locations: values.locations ?? [],
        defaultTrade: "other",
      });
    const named = await insert("AnyOf zqname project");
    const noted = await insert("AnyOf noted", { notes: "Ask about zqnotes" });
    const shed = await insert("AnyOf shed", {
      locations: ["Back zqshed", "Porch"],
    });
    const child = await insert("AnyOf child", { parent: shed });
    const grandchild = await insert("AnyOf grandchild", { parent: child });
    const overridden = await insert("AnyOf overridden", {
      parent: shed,
      locations: [],
    });
    const other = await insert("AnyOf other");
    const rows = [named, noted, shed, child, grandchild, overridden, other];
    const old = (term: string) =>
      or(
        formatSearchTerm(project.name, term),
        formatSearchTerm(project.notes, term),
        textArrayMatches(effectiveFieldSql("project", "locations"), term),
      );
    const projectMatches = await equivalence(
      [
        ["zqname", codes(named), old("zqname")],
        ["ZQNOTES", codes(noted), old("ZQNOTES")],
        ["zqshed", codes(shed, child, grandchild), old("zqshed")],
        // Elements match one at a time, never across the boundary.
        ["zqshed porch", [], old("zqshed porch")],
        ["zq", codes(named, noted, shed, child, grandchild), old("zq")],
      ],
      (term) => buildProjectWhere(db(), { search: term }),
      project,
      rows,
    );
    expect(projectMatches.actual).toEqual(projectMatches.expected);
  });

  it("matches a task by name or its inherited subject product's name", async () => {
    const widget = await insertWithShortcode(db(), "product", {
      name: "Zqwidget sander",
      brandId: null,
      model: "",
    });
    const gone = await insertWithShortcode(db(), "product", {
      name: "Zqgone drill",
      brandId: null,
      model: "",
    });
    await getDb(db())
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, gone.id));
    type Mode = "inherit" | "explicit";
    const insert = (
      name: string,
      values: {
        parent?: { id: string };
        subject?: [Mode, { id: string } | null];
      } = {},
    ) =>
      insertWithShortcode(db(), "task", {
        name,
        parentTaskId: (values.parent?.id ?? null) as never,
        projectMode: "inherit",
        assigneeMode: "inherit",
        subjectProductMode: values.subject?.[0] ?? "inherit",
        subjectProductId: (values.subject?.[1]?.id ?? null) as never,
        trade: "other",
      });
    const own = await insert("AnyOf sand", { subject: ["explicit", widget] });
    const child = await insert("AnyOf child", { parent: own });
    const grandchild = await insert("AnyOf grandchild", { parent: child });
    const none = await insert("AnyOf none", {
      parent: own,
      subject: ["explicit", null],
    });
    const named = await insert("AnyOf zqtask name");
    const deleted = await insert("AnyOf deleted subject", {
      subject: ["explicit", gone],
    });
    const rows = [own, child, grandchild, none, named, deleted];
    const qb = getDb(db());
    const old = (term: string) =>
      or(
        formatSearchTerm(task.name, term),
        sql`${effectiveFieldSql("task", "subjectProductId")} IN ${qb
          .select({ id: product.id })
          .from(product)
          .where(
            and(
              sql`${product.deletedAt} IS NULL`,
              formatSearchTerm(product.name, term),
            ),
          )}`,
      );
    const taskMatches = await equivalence(
      [
        ["zqwidget", codes(own, child, grandchild), old("zqwidget")],
        ["ZQTASK", codes(named), old("ZQTASK")],
        ["zqgone", [], old("zqgone")],
        ["zq", codes(own, child, grandchild, named), old("zq")],
      ],
      (term) => buildTaskWhere(db(), { search: term }),
      task,
      rows,
    );
    expect(taskMatches.actual).toEqual(taskMatches.expected);
  });

  it("matches a wish by name, notes, or any live candidate's name, brandName or model", async () => {
    const knownBrandId = await findOrCreateVendor(db(), "Zqmaker");
    const candidate = (
      name: string,
      brandId: typeof knownBrandId | null = null,
      model = "",
    ) =>
      insertWithShortcode(db(), "product", {
        name,
        brandId,
        model,
      });
    const byName = await candidate("Zqcandidate kettle");
    const byMaker = await candidate("Kettle", knownBrandId);
    const byModel = await candidate("Kettle", null, "ZQ-900");
    const unlinked = await candidate("Zqunlinked kettle");
    const deleted = await candidate("Zqdeleted kettle");
    const insert = (name: string, notes: string | null = null) =>
      insertWithShortcode(db(), "wish", { name, notes });
    const link = async (
      target: { id: string },
      ...candidates: { id: string }[]
    ) =>
      getDb(db())
        .insert(entityLink)
        .values(
          candidates.map((item) =>
            linkValues("wishCandidate", target.id, item.id),
          ),
        );
    const named = await insert("AnyOf zqwish name");
    const noted = await insert("AnyOf noted", "Compare zqnotes");
    const several = await insert("AnyOf several");
    await link(several, byName, byMaker);
    const modelled = await insert("AnyOf modelled");
    await link(modelled, byModel);
    const removedLink = await insert("AnyOf removed link");
    await link(removedLink, unlinked);
    await getDb(db())
      .update(entityLink)
      .set({ deletedAt: new Date() })
      .where(eq(entityLink.fromEntityId, removedLink.id));
    const removedProduct = await insert("AnyOf removed product");
    await link(removedProduct, deleted);
    // A link to a since-deleted candidate stays; the record no longer counts.
    await getDb(db())
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, deleted.id));
    const rows = [named, noted, several, modelled, removedLink, removedProduct];
    const old = (term: string) =>
      or(
        formatSearchTerm(wish.name, term),
        formatSearchTerm(wish.notes, term),
        sql`EXISTS (
          SELECT 1 FROM "EntityLink" wc
          JOIN "Product" p ON p."id" = wc."toEntityId" AND p."deletedAt" IS NULL
          WHERE wc."fromEntityId" = ${wish.id}
            AND wc."deletedAt" IS NULL AND wc."kind" = 'wishCandidate'
            AND (p."name" ILIKE ${`%${term}%`} OR p."brandName" ILIKE ${`%${term}%`} OR p."model" ILIKE ${`%${term}%`})
        )`,
      );
    const wishMatches = await equivalence(
      [
        ["zqwish", codes(named), old("zqwish")],
        ["ZQNOTES", codes(noted), old("ZQNOTES")],
        ["zqcandidate", codes(several), old("zqcandidate")],
        ["zqmaker", codes(several), old("zqmaker")],
        ["zq-900", codes(modelled), old("zq-900")],
        ["zqunlinked", [], old("zqunlinked")],
        ["zqdeleted", [], old("zqdeleted")],
        ["zq", codes(named, noted, several, modelled), old("zq")],
      ],
      (term) => buildWishWhere({ search: term }),
      wish,
      rows,
    );
    expect(wishMatches.actual).toEqual(wishMatches.expected);
  });

  it("keeps the folded column searches of ingredient, recipe and location", async () => {
    const own = (term: string, ...columns: SQL[]) =>
      or(...columns.map((column) => formatSearchTerm(column, term)));

    const flour = await insertWithShortcode(db(), "ingredient", {
      name: "Zqflour",
      aliases: [],
    });
    const aliased = await insertWithShortcode(db(), "ingredient", {
      name: "Meal",
      aliases: ["Rye", "Zqrye meal"],
    });
    const plain = await insertWithShortcode(db(), "ingredient", {
      name: "Salt",
      aliases: [],
    });
    const ingredients = [flour, aliased, plain];
    const oldIngredient = (term: string) =>
      or(
        formatSearchTerm(ingredient.name, term),
        textArrayMatches(ingredient.aliases, term),
      );
    const ingredientMatches = await equivalence(
      [
        ["zqflour", codes(flour), oldIngredient("zqflour")],
        ["ZQRYE", codes(aliased), oldIngredient("ZQRYE")],
        ["rye zqrye", [], oldIngredient("rye zqrye")],
        ["zq", codes(flour, aliased), oldIngredient("zq")],
      ],
      (term) => buildIngredientListWhere({ nameFilter: term }),
      ingredient,
      ingredients,
    );
    expect(ingredientMatches.actual).toEqual(ingredientMatches.expected);

    const named = await insertWithShortcode(db(), "recipe", {
      name: "Zqbread",
    });
    const noted = await insertWithShortcode(db(), "recipe", {
      name: "Loaf",
      notes: "Proof zqovernight",
    });
    const other = await insertWithShortcode(db(), "recipe", { name: "Soup" });
    const recipeMatches = await equivalence(
      [
        ["zqbread", codes(named), own("zqbread", sql`${recipe.name}`)],
        [
          "ZQOVERNIGHT",
          codes(noted),
          own("ZQOVERNIGHT", sql`${recipe.name}`, sql`${recipe.notes}`),
        ],
        [
          "zq",
          codes(named, noted),
          own("zq", sql`${recipe.name}`, sql`${recipe.notes}`),
        ],
      ],
      (term) => buildRecipeWhere({ nameFilter: term }),
      recipe,
      [named, noted, other],
    );
    expect(recipeMatches.actual).toEqual(recipeMatches.expected);

    const shelf = await insertWithShortcode(db(), "location", {
      name: "Zqshelf",
      type: "room",
      aliases: [],
    });
    const nook = await insertWithShortcode(db(), "location", {
      name: "Nook",
      type: "room",
      aliases: ["Zqnook"],
    });
    const hall = await insertWithShortcode(db(), "location", {
      name: "Hall",
      type: "room",
      aliases: [],
    });
    const oldLocation = (term: string) =>
      or(
        formatSearchTerm(location.name, term),
        textArrayMatches(location.aliases, term),
      );
    const locationMatches = await equivalence(
      [
        ["zqshelf", codes(shelf), oldLocation("zqshelf")],
        ["zqnook", codes(nook), oldLocation("zqnook")],
        ["zq", codes(shelf, nook), oldLocation("zq")],
      ],
      (term) => buildLocationWhere(db(), { nameFilter: term }),
      location,
      [shelf, nook, hall],
    );
    expect(locationMatches.actual).toEqual(locationMatches.expected);
  });
});
