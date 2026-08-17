import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Entity } from "@cubby/schemas/entity";
import { entitySchema } from "@cubby/schemas/entity";
import {
  financialAccountCreateInput,
  financialAccountFilterFields,
} from "@cubby/schemas/financial-account";
import {
  financialTransactionCreateInput,
  financialTransactionFilterFields,
} from "@cubby/schemas/financial-transaction";
import { imageFilterFields } from "@cubby/schemas/image";
import { ingredientFilterFields } from "@cubby/schemas/ingredient";
import { inventoryFilterFields } from "@cubby/schemas/inventory";
import { locationFilterFields } from "@cubby/schemas/location";
import { mealCreateInput, mealFilterFields } from "@cubby/schemas/meal";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { productFilterFields } from "@cubby/schemas/product";
import {
  expenseCreateInput,
  expenseFilterFields,
  projectCreateInput,
  projectFilterFields,
  taskCreateInput,
  taskFilterFields,
} from "@cubby/schemas/project";
import {
  purchaseCreateInput,
  purchaseFilterFields,
} from "@cubby/schemas/purchase";
import { recipeFilterFields } from "@cubby/schemas/recipe";
import { vendorCreateInput, vendorFilterFields } from "@cubby/schemas/vendor";
import { wishFilterFields } from "@cubby/schemas/wish";
import type { ShortcodeType } from "@cubby/shared";
import { SHORTCODE_PREFIX } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Database } from "~/server/db";
import { upsertCookbook } from "./cookbook";
import { createExpense, expenseList } from "./expense";
import {
  createFinancialAccount,
  listFinancialAccounts,
} from "./financial-account";
import {
  createFinancialTransaction,
  listFinancialTransactions,
} from "./financial-transaction";
import { createUploadedImageRecord, imageList } from "./image";
import { createIngredient, ingredientList } from "./ingredient";
import { inventoryentryList } from "./inventory";
import { createLocation, locationList } from "./location";
import { createMeal, mealList } from "./meal";
import { productList } from "./product";
import { createProject, projectList } from "./project";
import { createPurchase, purchaseList } from "./purchase";
import { recipeList } from "./recipe";
import {
  createInventoryFixture,
  createProductFixture,
  createRecipeFixture,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createTask, taskList } from "./task";
import { createVendor, getVendorByID, vendorList } from "./vendor";
import { createWish, wishList } from "./wish";

/**
 * Generic guard for the "declared filter, unapplied filter" bug class, which has
 * now shipped three times:
 *
 * 1. #591 — `eqAny(column, [])` is "no constraint" BY DESIGN. A filter naming an
 *    id that resolved to no live row had its predicate DROPPED, so the query
 *    returned the ENTIRE table instead of nothing.
 * 2. #591 — `resolveShortcodes` keys its Map by the CANONICAL code while the
 *    caller looked up by the raw input, so a lowercase code resolved to nothing
 *    and fed bug 1.
 * 3. #588 — `wishFilterFields` spread `auditDateFilterFields` and the related-view
 *    trio, and the manifest rendered controls for them, but `buildWishWhere` never
 *    called `auditDateWhereConditions` / `relatedWhereConditions`. The UI sent
 *    filters the server silently ignored.
 *
 * Nothing caught any of them. `entities/filter-manifest.unit.test.tsx` checks only
 * that every field the manifest EMITS exists as a key on the entity's
 * `*FilterFields` — never that the repo READS it, nor what happens when a supplied
 * value resolves to nothing.
 *
 * This file closes that: for every entity that declares `*FilterFields`, it seeds a
 * world, derives an IMPOSSIBLE value for each declared field from that field's own
 * schema, and asserts the list narrows. It is driven entirely by the declarations —
 * a new entity or a newly-spread field is covered with no edit here. That property
 * is the point: the hand-kept `auditFilterEntities` list in the manifest is exactly
 * what went stale in #588.
 */

const PAGE: PaginationParams = { pageIndex: 0, pageSize: 100 };
const NO_SORT: SortParams[] = [];

/** A string no seeded row contains and no format-constrained schema accepts. */
const IMPOSSIBLE_TEXT = "zzq-no-such-value-zzq";
/** Lower bound after every row; upper bound before every row. */
const FAR_FUTURE = "2999-01-01";
const FAR_PAST = "1000-01-01";
/**
 * Beyond any money/count a seeded row carries, in either direction. Kept inside
 * int4 — several bounds land on `integer` columns, and Postgres rejects a wider
 * parameter outright rather than comparing it.
 */
const HUGE = 1_000_000_000;
/** Well-formed but unmintable body — `resolveShortcodes` finds nothing for it. */
const UNRESOLVABLE_BODY = "9999";

// Field classification

/**
 * How a declared field is probed. Derived from what the field's OWN schema
 * accepts, never from a hand-written per-field table — a field whose schema
 * changes shape is re-classified automatically.
 */
type Probe =
  /** A shortcode-typed id. Gets the full #591 battery. */
  | { kind: "id"; target: ShortcodeType }
  /** Free text (search, substring, exact free-form id). */
  | { kind: "text"; value: unknown }
  /** A `YYYY-MM-DD` bound. */
  | { kind: "date"; value: string }
  /** A numeric bound. */
  | { kind: "number"; value: number }
  /**
   * SKIPPED BY KIND — a boolean names two states a row can genuinely be in.
   * Neither `true` nor `false` is impossible, so "returns fewer rows" is not a
   * property a boolean filter has.
   */
  | { kind: "skip:boolean" }
  /**
   * SKIPPED BY KIND — an upper bound on a schema that rejects negatives
   * (`.nonnegative()` / `.positive()`). Its smallest legal value (0 or 1)
   * legitimately matches real rows, so no impossible value exists.
   */
  | { kind: "skip:bounded-max" }
  /**
   * SKIPPED BY KIND — an enum (including the `has`/`none` presence sentinels and
   * the status/kind/trade picklists), an object scope, or a format-constrained
   * scalar (4-digit year, card last-4). Every syntactically valid value names a
   * cohort some row could plausibly be in, so none of them is impossible.
   */
  | { kind: "skip:closed-domain" };

const accepts = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).success;

const boundDirection = (field: string): "lower" | "upper" | null => {
  const lower = field.toLowerCase();
  if (lower.endsWith("from") || lower.endsWith("min")) return "lower";
  if (lower.endsWith("to") || lower.endsWith("max")) return "upper";
  return null;
};

const classify = (field: string, schema: z.ZodType): Probe => {
  const numeric = accepts(schema, HUGE);
  // `z.coerce.number()` accepts `true` (Number(true) === 1), so a boolean is only
  // a boolean when it does NOT also take a number.
  if (!numeric && accepts(schema, true)) return { kind: "skip:boolean" };

  if (accepts(schema, IMPOSSIBLE_TEXT)) {
    return { kind: "text", value: IMPOSSIBLE_TEXT };
  }
  // Array-only fields (`tagFilters`); `oneOrMany` already took the scalar arm.
  if (accepts(schema, [IMPOSSIBLE_TEXT])) {
    return { kind: "text", value: [IMPOSSIBLE_TEXT] };
  }

  const direction = boundDirection(field);
  if (accepts(schema, FAR_FUTURE) && direction) {
    return {
      kind: "date",
      value: direction === "lower" ? FAR_FUTURE : FAR_PAST,
    };
  }

  if (numeric && direction) {
    if (direction === "lower") return { kind: "number", value: HUGE };
    if (accepts(schema, -HUGE)) return { kind: "number", value: -HUGE };
    return { kind: "skip:bounded-max" };
  }

  for (const target of Object.keys(SHORTCODE_PREFIX) as ShortcodeType[]) {
    if (accepts(schema, `${SHORTCODE_PREFIX[target]}${UNRESOLVABLE_BODY}`)) {
      return { kind: "id", target };
    }
  }

  return { kind: "skip:closed-domain" };
};

// The world every probe runs against

type Seeded = {
  /** One live shortcode per entity, for the "real id" and wrong-prefix probes. */
  codes: Record<ShortcodeType, string>;
};

/**
 * Two rows of every entity, deliberately UNRELATED to each other. Two rows make
 * "returned everything" distinguishable from "returned one match"; keeping them
 * unrelated means a filter naming a real id of another entity must match nothing,
 * which is what makes the lowercase/uppercase comparison below meaningful.
 */
const seedWorld = async (ctx: {
  db: Database;
  actor: Parameters<typeof createVendor>[2];
}): Promise<Seeded> => {
  const { db, actor } = ctx;

  const vendors = [];
  for (const name of ["Guard Vendor Alpha", "Guard Vendor Beta"]) {
    const { entityId } = await createVendor(
      db,
      vendorCreateInput.parse({ name }),
      actor,
    );
    vendors.push((await getVendorByID(db, entityId)).id);
  }
  const vendorCode = vendors[0];
  if (!vendorCode) throw new Error("seed: vendor not created");

  const purchases = [];
  for (const date of ["2024-03-01", "2024-03-02"]) {
    const { output } = await createPurchase(
      db,
      purchaseCreateInput.parse({ vendorId: vendorCode, date }),
      actor,
    );
    purchases.push(output.id);
  }

  const products = [];
  for (const name of ["Guard Product Alpha", "Guard Product Beta"]) {
    products.push(
      await createProductFixture(db, makeProductInput({ name }), actor),
    );
  }

  const locations = [];
  for (const name of ["Guard Location Alpha", "Guard Location Beta"]) {
    const created = await createLocation(
      db,
      makeLocationInput({ name }),
      actor,
    );
    if (!created) throw new Error("seed: location not created");
    locations.push(created);
  }

  const ingredients = [];
  for (const name of ["guard ingredient alpha", "guard ingredient beta"]) {
    ingredients.push(await createIngredient(db, { name, aliases: [] }, actor));
  }

  const inventories = [];
  for (const [index, product] of products.entries()) {
    const location = locations[index];
    if (!location) throw new Error("seed: location missing");
    inventories.push(
      await createInventoryFixture(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      ),
    );
  }

  const recipes = [];
  for (const name of ["Guard Recipe Alpha", "Guard Recipe Beta"]) {
    recipes.push(
      await createRecipeFixture(db, makeRecipeInput({ name }), actor),
    );
  }

  const meals = [];
  for (const date of ["2024-05-01", "2024-05-02"]) {
    meals.push(
      await createMeal(
        db,
        mealCreateInput.parse({ date, name: "Guard Meal" }),
        actor,
      ),
    );
  }

  const projects = [];
  for (const name of ["Guard Project Alpha", "Guard Project Beta"]) {
    const { output } = await createProject(
      db,
      projectCreateInput.parse({ name, status: "in_progress" }),
      actor,
    );
    projects.push(output);
  }

  const tasks = [];
  for (const name of ["Guard Task Alpha", "Guard Task Beta"]) {
    const { output } = await createTask(
      db,
      taskCreateInput.parse({ name, trade: "other" }),
      actor,
    );
    tasks.push(output);
  }

  const expenses = [];
  for (const name of ["Guard Expense Alpha", "Guard Expense Beta"]) {
    const { output } = await createExpense(
      db,
      expenseCreateInput.parse({
        name,
        trade: "other",
        costType: "materials",
        cost: 10,
        date: "2024-02-01",
      }),
      actor,
    );
    expenses.push(output);
  }

  const accounts = [];
  for (const [index, name] of [
    "Guard Card Alpha",
    "Guard Card Beta",
  ].entries()) {
    const { output } = await createFinancialAccount(
      db,
      financialAccountCreateInput.parse({
        name,
        identity: {
          kind: "credit_card",
          issuer: null,
          network: "visa",
          last4: `100${index}`,
        },
      }),
      actor,
    );
    accounts.push(output);
  }
  const accountCode = accounts[0];
  if (!accountCode) throw new Error("seed: financial account not created");

  const transactions = [];
  for (const [index, date] of ["2024-04-01", "2024-04-02"].entries()) {
    const { output } = await createFinancialTransaction(
      db,
      financialTransactionCreateInput.parse({
        accountId: accountCode.id,
        kind: "purchase",
        status: "posted",
        amount: 5 + index,
        postedDate: date,
        rawDescription: `GUARD LINE ${index}`,
      }),
      actor,
    );
    transactions.push(output);
  }

  const wishes = [];
  for (const name of ["guard wish alpha", "guard wish beta"]) {
    const { output } = await createWish(
      db,
      { name, notes: null, candidateProductIds: [] },
      actor,
    );
    wishes.push(output);
  }

  for (const filename of ["guard-alpha.jpg", "guard-beta.jpg"]) {
    await createUploadedImageRecord(db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: `https://example.com/${filename}`,
      filename,
      contentType: "image/jpeg",
      size: 2048,
    });
  }

  const cookbooks = [];
  for (const name of ["Guard Cookbook Alpha", "Guard Cookbook Beta"]) {
    const { output } = await upsertCookbook(
      db,
      { name, rawJson: [], author: [], sourceLabel: `${name}.epub` },
      actor,
    );
    cookbooks.push(output);
  }

  const first = <T>(rows: T[], what: string): T => {
    const row = rows[0];
    if (!row) throw new Error(`seed: ${what} not created`);
    return row;
  };

  return {
    codes: {
      cookbook: first(cookbooks, "cookbook").id,
      expense: first(expenses, "expense").id,
      financialAccount: accountCode.id,
      financialTransaction: first(transactions, "transaction").id,
      ingredient: first(ingredients, "ingredient").id,
      inventory: first(inventories, "inventory").id,
      location: first(locations, "location").id,
      meal: first(meals, "meal").id,
      product: first(products, "product").id,
      project: first(projects, "project").id,
      purchase: first(purchases, "purchase"),
      recipe: first(recipes, "recipe").id,
      task: first(tasks, "task").id,
      vendor: vendorCode,
      wish: first(wishes, "wish").id,
    },
  };
};

// The registry: every entity that declares filter fields, plus its list call

type ListProbe = (
  db: Database,
  filters: Record<string, unknown>,
) => Promise<{ ids: string[]; count: number }>;

/**
 * Adapts a repo list function to the probe shape. The single localized cast: the
 * probe deliberately feeds values the entity's `Filters` type would reject at the
 * type level (a lowercase code, a wrong-prefix code) because that is exactly what
 * an unvalidated caller can do at runtime, and what #591 was.
 */
const listFor =
  <F, R extends { id: string }>(
    fn: (
      db: Database,
      filters: F,
      sorts: SortParams[],
      pagination: PaginationParams,
    ) => Promise<{ data: R[]; count: number }>,
  ): ListProbe =>
  async (db, filters) => {
    const { data, count } = await fn(db, filters as F, NO_SORT, PAGE);
    return { ids: data.map((row) => row.id), count };
  };

const GUARDS = {
  // `buildExpenseWhereClause` (the where-builder this guards, transitively)
  // now also backs `projectPortfolioAnalytics`'s expense-grouped chart
  // aggregates (repo/project/portfolio-analytics.ts). That endpoint takes a
  // different, project-shaped filter vocabulary with no `{id, count}`-shaped
  // list to plug into `listFor` here, so it can't join this per-field probe
  // loop directly — its own regression coverage (date bounds still applying,
  // and its `search` — PROJECT name — never leaking into this builder's
  // expense-NAME `search`) lives in `project.integration.test.ts`'s "project
  // dashboard — portfolio analytics" describe block instead.
  expense: { fields: expenseFilterFields, list: listFor(expenseList) },
  financialAccount: {
    fields: financialAccountFilterFields,
    list: listFor(listFinancialAccounts),
  },
  financialTransaction: {
    fields: financialTransactionFilterFields,
    list: listFor(listFinancialTransactions),
  },
  image: { fields: imageFilterFields, list: listFor(imageList) },
  ingredient: { fields: ingredientFilterFields, list: listFor(ingredientList) },
  inventory: {
    fields: inventoryFilterFields,
    list: listFor(inventoryentryList),
  },
  location: { fields: locationFilterFields, list: listFor(locationList) },
  meal: { fields: mealFilterFields, list: listFor(mealList) },
  product: { fields: productFilterFields, list: listFor(productList) },
  project: { fields: projectFilterFields, list: listFor(projectList) },
  purchase: { fields: purchaseFilterFields, list: listFor(purchaseList) },
  recipe: { fields: recipeFilterFields, list: listFor(recipeList) },
  task: { fields: taskFilterFields, list: listFor(taskList) },
  vendor: { fields: vendorFilterFields, list: listFor(vendorList) },
  wish: { fields: wishFilterFields, list: listFor(wishList) },
} satisfies Partial<
  Record<Entity, { fields: Record<string, z.ZodType>; list: ListProbe }>
>;

type GuardedEntity = keyof typeof GUARDS;
const GUARDED_ENTITIES = Object.keys(GUARDS) as GuardedEntity[];

/**
 * Fields the guard KNOWS the repo ignores, so the suite stays green while the gap
 * stays visible. Every entry is a bug, not a carve-out — an entry that starts
 * passing must be deleted (asserted below), and an entry naming a field that no
 * longer exists is stale (also asserted).
 */
const KNOWN_GAPS: Record<string, string> = {};

describe("every declared filter field is applied by its repo", () => {
  const ctx = withTestDb();

  it.each(GUARDED_ENTITIES)("%s", async (entity) => {
    const world = await seedWorld(ctx);
    const { fields, list } = GUARDS[entity];
    const baseline = await list(ctx.db, {});
    expect(baseline.count).toBeGreaterThanOrEqual(2);

    const violations: string[] = [];
    const passingKnownGaps: string[] = [];

    const record = (field: string, message: string) => {
      const key = `${entity}.${field}`;
      if (key in KNOWN_GAPS) return;
      violations.push(`${key}: ${message}`);
    };

    for (const [field, schema] of Object.entries(fields)) {
      const probe = classify(field, schema as z.ZodType);
      const key = `${entity}.${field}`;
      const before = violations.length;

      if (probe.kind === "id") {
        // Bug 1: a well-formed code that resolves to no live row must match
        // nothing. `eqAny([])` is "no constraint", so an unapplied guard here
        // returns the whole table.
        const unresolvable = await list(ctx.db, {
          [field]: `${SHORTCODE_PREFIX[probe.target]}${UNRESOLVABLE_BODY}`,
        });
        if (unresolvable.count !== 0) {
          record(
            field,
            `an unresolvable ${probe.target} code returned ${unresolvable.count} rows (baseline ${baseline.count}); it must match nothing`,
          );
        }

        const real = world.codes[probe.target];
        // Bug 2: `resolveShortcodes` keys its Map by the CANONICAL code. A
        // lowercase code that isn't canonicalized resolves to nothing and widens
        // to the whole table, so the two forms must agree row-for-row.
        const upper = await list(ctx.db, { [field]: real });
        const lower = await list(ctx.db, { [field]: real.toLowerCase() });
        if (lower.count !== upper.count) {
          record(
            field,
            `a lowercase ${real} matched ${lower.count} rows but its canonical form matched ${upper.count}`,
          );
        }

        // The entity guard: a code of the wrong entity must resolve to nothing,
        // never widen. Picks any other seeded entity's live code.
        const otherTarget = (
          Object.keys(SHORTCODE_PREFIX) as ShortcodeType[]
        ).find((candidate) => candidate !== probe.target);
        if (otherTarget) {
          const wrongPrefix = await list(ctx.db, {
            [field]: world.codes[otherTarget],
          });
          if (wrongPrefix.count !== 0) {
            record(
              field,
              `a ${otherTarget} code returned ${wrongPrefix.count} rows; a wrong-prefix code must match nothing`,
            );
          }
        }
      } else if (
        probe.kind === "text" ||
        probe.kind === "date" ||
        probe.kind === "number"
      ) {
        // Bug 3: the field is declared (and the manifest renders a control for
        // it), but the where-builder never reads it. An impossible value that
        // still returns the unfiltered list is that bug.
        const filtered = await list(ctx.db, { [field]: probe.value });
        if (filtered.count !== 0) {
          record(
            field,
            `an impossible ${probe.kind} value (${JSON.stringify(probe.value)}) returned ${filtered.count} rows (baseline ${baseline.count}); it must match nothing`,
          );
        }
      }

      if (key in KNOWN_GAPS && violations.length === before) {
        // Only meaningful for probed kinds — a skipped kind never records
        // anything, so it can't "start passing".
        if (probe.kind === "id" || !probe.kind.startsWith("skip:")) {
          passingKnownGaps.push(key);
        }
      }
    }

    expect(violations).toEqual([]);
    expect(passingKnownGaps).toEqual([]);
  });
});

describe("guard coverage", () => {
  /**
   * The registry above must cover every `<entity>FilterFields` the schemas package
   * exports. Scanned from source rather than listed, so a new entity's filters are
   * covered the moment they're declared — a hand-kept list is what went stale in
   * #588.
   */
  it("registers every entity that declares filter fields", () => {
    const schemaSrc = fileURLToPath(
      new URL("../../../../../packages/schemas/src/", import.meta.url),
    );
    const declared = new Set<Entity>();
    for (const file of readdirSync(schemaSrc)) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      const source = readFileSync(`${schemaSrc}${file}`, "utf8");
      for (const match of source.matchAll(
        /export const (\w+)FilterFields\b/g,
      )) {
        const name = match[1];
        // `auditDate`, `<entity>Related`, `recipeList` etc. are composable
        // fragments, not an entity's own declaration.
        const parsed = entitySchema.safeParse(name);
        if (parsed.success) declared.add(parsed.data);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...GUARDED_ENTITIES].sort());
  });

  const fieldSchema = (key: string): z.ZodType | undefined => {
    const [entity, field] = key.split(".");
    const guard = GUARDS[entity as GuardedEntity] as
      | { fields: Record<string, z.ZodType> }
      | undefined;
    if (!guard || !field) return undefined;
    return guard.fields[field];
  };

  it("keeps the known-gap list free of fields that no longer exist", () => {
    const stale = Object.keys(KNOWN_GAPS).filter(
      (key) => fieldSchema(key) === undefined,
    );
    expect(stale).toEqual([]);
  });

  /**
   * Every declared field is either probed or skipped by a kind whose value space
   * has no impossible member. Pinning the skip roster keeps a newly-declared field
   * from disappearing into a skip bucket unnoticed — a change here is a prompt to
   * check whether that field really is unprobeable.
   */
  it("skips only kinds that cannot express an impossible value", () => {
    const skippedKinds = new Set<string>();
    for (const entity of GUARDED_ENTITIES) {
      for (const [field, schema] of Object.entries(GUARDS[entity].fields)) {
        const probe = classify(field, schema as z.ZodType);
        if (probe.kind.startsWith("skip:")) skippedKinds.add(probe.kind);
      }
    }
    expect([...skippedKinds].sort()).toEqual([
      "skip:boolean",
      "skip:bounded-max",
      "skip:closed-domain",
    ]);
  });
});
