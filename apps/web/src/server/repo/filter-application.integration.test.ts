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
import {
  ledgerPartyCreateInput,
  ledgerPartyFilterFields,
} from "@cubby/schemas/ledger-party";
import {
  ledgerTransferCreateInput,
  ledgerTransferFilterFields,
} from "@cubby/schemas/ledger-transfer";
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
import { createLedgerParty, listLedgerParties } from "./ledger-party";
import { createLedgerTransfer, listLedgerTransfers } from "./ledger-transfer";
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
  ingredientRef,
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

const IMPOSSIBLE_TEXT = "zzq-no-such-value-zzq";
const FAR_FUTURE = "2999-01-01";
const FAR_PAST = "1000-01-01";
/**
 * Beyond any money/count a seeded row carries, in either direction. Kept inside
 * int4 — several bounds land on `integer` columns, and Postgres rejects a wider
 * parameter outright rather than comparing it.
 */
const HUGE = 1_000_000_000;
const UNRESOLVABLE_BODY = "9999";

/**
 * How a declared field is probed. Derived from what the field's OWN schema
 * accepts, never from a hand-written per-field table — a field whose schema
 * changes shape is re-classified automatically.
 */
/**
 * Every shortcoded entity a filter probe can target — i.e. all of them except
 * `image`, which carries an `IMG-` code so it stops being a raw-uuid carve-out
 * elsewhere, but declares no filter fields and has no list probe here.
 */
type ProbeableTarget = Exclude<ShortcodeType, "image">;
const PROBEABLE_TARGETS = (
  Object.keys(SHORTCODE_PREFIX) as ShortcodeType[]
).filter((t): t is ProbeableTarget => t !== "image");

type Probe =
  /** A shortcode-typed id. Gets the full #591 battery. */
  | { kind: "id"; target: ProbeableTarget }
  | { kind: "text"; value: unknown }
  | { kind: "date"; value: string }
  | { kind: "number"; value: number }
  | { kind: "skip:boolean" }
  | { kind: "skip:bounded-max" }
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

  for (const target of PROBEABLE_TARGETS) {
    if (accepts(schema, `${SHORTCODE_PREFIX[target]}${UNRESOLVABLE_BODY}`)) {
      return { kind: "id", target };
    }
  }

  return { kind: "skip:closed-domain" };
};

type Seeded = {
  /** One live shortcode per entity, for the "real id" and wrong-prefix probes. */
  // Excludes `image`: it has a shortcode so it stops being a raw-uuid carve-out
  // elsewhere, but it declares no filter fields and has no list probe, so there
  // is nothing here for a sample code to exercise.
  codes: Record<ProbeableTarget, string>;
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

  const ingredients = [];
  for (const name of ["guard ingredient alpha", "guard ingredient beta"]) {
    ingredients.push(await createIngredient(db, { name, aliases: [] }, actor));
  }
  const ingredientAlpha = ingredients[0];
  if (!ingredientAlpha) throw new Error("seed: ingredient not created");

  // Alpha is "tools" so it's a legal wish candidate below (createWish rejects
  // any non-tool product) — `wishFilterFields.candidateProductId` non-vacuity.
  // NOT linked to an ingredient: `hasFoodIndicators` force-overrides category
  // to "food" the moment ingredientId is set, which would make Alpha fail the
  // wish's tools-only check — the two links are mutually exclusive on one
  // row, so `productFilterFields.ingredientIdFilter` stays in
  // VACUOUS_ID_FIELDS instead.
  // Alpha carries a tag and a unit mapping — `productFilterFields.
  // {tagsPresenceFilter,unitMappingPresenceFilter}` non-vacuity.
  const products = [];
  for (const name of ["Guard Product Alpha", "Guard Product Beta"]) {
    const isAlpha = name === "Guard Product Alpha";
    products.push(
      await createProductFixture(
        db,
        makeProductInput({
          name,
          category: isAlpha ? "tools" : undefined,
          tags: isAlpha ? ["guard-product-tag"] : undefined,
          unitMappings: isAlpha
            ? [
                {
                  a: { value: 1, unit: "box" },
                  b: { value: 4, unit: "each" },
                  source: null,
                },
              ]
            : undefined,
        }),
        actor,
      ),
    );
  }
  const productAlpha = products[0];
  if (!productAlpha) throw new Error("seed: product not created");

  const locationAlpha = await createLocation(
    db,
    makeLocationInput({ name: "Guard Location Alpha" }),
    actor,
  );
  if (!locationAlpha) throw new Error("seed: location not created");
  const locationBeta = await createLocation(
    db,
    makeLocationInput({
      name: "Guard Location Beta",
      parentId: locationAlpha.id,
      productId: productAlpha.id,
    }),
    actor,
  );
  if (!locationBeta) throw new Error("seed: location not created");
  const locations = [locationAlpha, locationBeta];

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
      await createRecipeFixture(
        db,
        makeRecipeInput({
          name,
          ...(name === "Guard Recipe Alpha"
            ? {
                tags: ["guard-recipe-tag"],
                sections: [
                  { ingredients: [ingredientRef(ingredientAlpha.id)] },
                ],
              }
            : {}),
        }),
        actor,
      ),
    );
  }
  const recipeAlpha = recipes[0];
  if (!recipeAlpha) throw new Error("seed: recipe not created");

  const meals = [];
  for (const [index, date] of ["2024-05-01", "2024-05-02"].entries()) {
    meals.push(
      await createMeal(
        db,
        mealCreateInput.parse({
          date,
          name: "Guard Meal",
          recipes: index === 0 ? [{ recipeId: recipeAlpha.id }] : undefined,
        }),
        actor,
      ),
    );
  }

  const { output: projectAlpha } = await createProject(
    db,
    projectCreateInput.parse({
      name: "Guard Project Alpha",
      status: "in_progress",
    }),
    actor,
  );
  const { output: projectBeta } = await createProject(
    db,
    projectCreateInput.parse({
      name: "Guard Project Beta",
      status: "in_progress",
      parentProjectId: projectAlpha.id,
    }),
    actor,
  );
  const projects = [projectAlpha, projectBeta];

  const { output: taskAlpha } = await createTask(
    db,
    taskCreateInput.parse({
      name: "Guard Task Alpha",
      trade: "other",
      subjectProductId: productAlpha.id,
      projectId: projectAlpha.id,
    }),
    actor,
  );
  const { output: taskBeta } = await createTask(
    db,
    taskCreateInput.parse({
      name: "Guard Task Beta",
      trade: "other",
      parentTaskId: taskAlpha.id,
    }),
    actor,
  );
  const tasks = [taskAlpha, taskBeta];

  // Alpha carries a purchaseId (which resolves a vendorId through it),
  // projectId and productId — same non-vacuity reasoning again, for
  // `expenseFilterFields.{purchaseId,vendorId,projectId,productId}`. Beta
  // stays link-free, which is what keeps the wrong-prefix / unresolvable-id
  // probes elsewhere in this file meaningful (a real id of some OTHER entity
  // must still match nothing).
  const { output: expenseAlpha } = await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Expense Alpha",
      trade: "other",
      costType: "materials",
      cost: 10,
      date: "2024-02-01",
      productId: productAlpha.id,
      projectId: projectAlpha.id,
      purchaseId: purchases[0],
    }),
    actor,
  );
  const { output: expenseBeta } = await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Expense Beta",
      trade: "other",
      costType: "materials",
      cost: 10,
      date: "2024-02-01",
    }),
    actor,
  );
  const expenses = [expenseAlpha, expenseBeta];

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

  const ledgerParties = [];
  for (const name of ["Guard ledger member", "Guard ledger guest"]) {
    const { output } = await createLedgerParty(
      db,
      ledgerPartyCreateInput.parse({
        name,
        kind: name.endsWith("member") ? "member" : "guest",
      }),
      actor,
    );
    ledgerParties.push(output);
  }
  const [firstLedgerParty, secondLedgerParty] = ledgerParties;
  if (!firstLedgerParty || !secondLedgerParty)
    throw new Error("seed: ledger parties not created");
  // The second transfer runs the pair in REVERSE — so Alpha (`firstLedgerParty`)
  // appears as both a `fromPartyId` and a `toPartyId` across the two rows,
  // which `ledgerTransferFilterFields.{fromPartyId,toPartyId}` non-vacuity
  // needs (a same-direction pair only ever puts Alpha on one side).
  const ledgerTransfers = [];
  for (const [index, date] of ["2024-06-01", "2024-06-02"].entries()) {
    const reversed = index % 2 === 1;
    const { output } = await createLedgerTransfer(
      db,
      ledgerTransferCreateInput.parse({
        fromPartyId: reversed ? secondLedgerParty.id : firstLedgerParty.id,
        toPartyId: reversed ? firstLedgerParty.id : secondLedgerParty.id,
        amount: 10,
        date,
      }),
      actor,
    );
    ledgerTransfers.push(output);
  }

  const transactions = [];
  for (const [index, date] of ["2024-04-01", "2024-04-02"].entries()) {
    const { output } = await createFinancialTransaction(
      db,
      financialTransactionCreateInput.parse({
        accountId: accountCode.id,
        purchaseId: index === 0 ? purchases[0] : null,
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
      {
        name,
        notes: null,
        candidateProductIds:
          name === "guard wish alpha" ? [productAlpha.id] : [],
      },
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
      ledgerParty: firstLedgerParty.id,
      ledgerTransfer: first(ledgerTransfers, "ledger transfer").id,
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

type ListProbe = (
  db: Database,
  filters: Record<string, unknown>,
) => Promise<{ ids: string[]; count: number }>;

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
  ledgerParty: {
    fields: ledgerPartyFilterFields,
    list: listFor(listLedgerParties),
  },
  ledgerTransfer: {
    fields: ledgerTransferFilterFields,
    list: listFor(listLedgerTransfers),
  },
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

/**
 * `id`-kind fields where NO seeded row carries a real id — the
 * lowercase-vs-canonical comparison in the `"id"` branch below would compare
 * zero rows against zero rows and pass whether or not canonicalization
 * actually works. That is precisely how #591 stayed invisible: the guard ran,
 * "passed", and proved nothing.
 *
 * `seedWorld` links Alpha rows to Alpha of the entities they directly
 * reference (purchase→vendor, expense→{product,vendor,purchase},
 * task→{parentTask,subjectProduct}, project→parentProject,
 * inventory→{product,location}, ledgerTransfer→{fromParty,toParty},
 * financialTransaction→account) specifically so those fields are NOT here.
 * Every entry below is a `*RelatedFilterFields` trio id — resolved through a
 * multi-hop join (`relatedWhereConditions`, repo/related-view.ts) rather than
 * a column on the entity's own table — which a two-row generic world has no
 * economical way to populate for every entity pair. That is a real, if
 * self-imposed, coverage gap: a lowercase-canonicalization regression in one
 * of these trio ids would ship silently. Closing it means either teaching
 * `seedWorld` to wire up every relationship (a combinatorial blow-up: 9 for
 * `product` alone) or giving each one a dedicated, hand-seeded test — future
 * work, not this pass.
 *
 * An entry that starts matching a real row (because a later `seedWorld` edit
 * happens to link it) is stale and must be deleted — asserted below, same as
 * `KNOWN_GAPS`.
 */
const VACUOUS_ID_FIELDS: Record<string, string> = {
  "product.ingredientIdFilter":
    "mutually exclusive with the wish-candidate link on Alpha — hasFoodIndicators force-overrides category to 'food' the instant ingredientId is set, and the wish candidate below needs Alpha to stay 'tools'",
  "inventory.ingredientId":
    "resolved through InventoryEntry→Product→ingredientId — same gap as product.ingredientIdFilter, no seeded product carries one",
  "location.ingredientId":
    "resolved through InventoryEntry→Product→ingredientId — same gap as product.ingredientIdFilter, no seeded product carries one",
  "product.usedOnProjectId":
    "ProjectToolUsage join row — no seeded row records a product as a project's tool",
  "project.usedToolId":
    "ProjectToolUsage join row — same gap as product.usedOnProjectId, other direction",
  "project.projectId":
    "the project 'blocked-by' trio (ProjectDependency) — settable only via the UPDATE-only blockedByIds, not createProject",
  "task.blockedByTaskId":
    "the task 'blocked-by' trio (TaskDependency) — settable only via the UPDATE-only blockedByIds, not createTask",
  "recipe.cookbookId":
    "Recipe.cookbookId is set by the EPUB/URL importer, not createRecipe — no create-time field exists to link it",
};

describe("every declared filter field is applied by its repo", () => {
  const ctx = withTestDb();

  it.each(GUARDED_ENTITIES)("%s", async (entity) => {
    const world = await seedWorld(ctx);
    const { fields, list } = GUARDS[entity];
    const baseline = await list(ctx.db, {});
    expect(baseline.count).toBeGreaterThanOrEqual(2);

    const violations: string[] = [];
    const passingKnownGaps: string[] = [];
    // Roster entries that turned out non-vacuous — stale, must be deleted.
    const passingVacuousIdFields: string[] = [];

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
        if (upper.count === 0) {
          // Comparing lower against upper here would be 0-vs-0 — vacuously
          // equal regardless of whether canonicalization works. That is
          // exactly how #591 hid: skip the comparison, but only for a field
          // this suite has DECIDED can't be linked (see VACUOUS_ID_FIELDS'
          // header) — anywhere else, a field with no live match is itself the
          // violation.
          if (key in VACUOUS_ID_FIELDS) {
          } else {
            record(
              field,
              `no seeded row carries a real ${probe.target} id — the canonical form matched 0 rows, so the lowercase comparison below would be vacuous. Link a row in seedWorld, or add "${key}" to VACUOUS_ID_FIELDS if it genuinely can't be linked`,
            );
          }
        } else {
          if (key in VACUOUS_ID_FIELDS) {
            passingVacuousIdFields.push(key);
          }
          const lower = await list(ctx.db, { [field]: real.toLowerCase() });
          if (lower.count !== upper.count) {
            record(
              field,
              `a lowercase ${real} matched ${lower.count} rows but its canonical form matched ${upper.count}`,
            );
          }
        }

        // The entity guard: a code of the wrong entity must resolve to nothing,
        // never widen. Picks any other seeded entity's live code.
        const otherTarget = PROBEABLE_TARGETS.find(
          (candidate) => candidate !== probe.target,
        );
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
    expect(passingVacuousIdFields).toEqual([]);
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

  it("keeps the vacuous-id-field roster free of fields that no longer exist", () => {
    const stale = Object.keys(VACUOUS_ID_FIELDS).filter(
      (key) => fieldSchema(key) === undefined,
    );
    expect(stale).toEqual([]);
  });

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

const isPresenceField = (field: string, schema: z.ZodType): boolean =>
  field.endsWith("PresenceFilter") &&
  accepts(schema, "has") &&
  accepts(schema, "none") &&
  !accepts(schema, IMPOSSIBLE_TEXT);

describe("every presence filter partitions its baseline", () => {
  const ctx = withTestDb();

  it.each(GUARDED_ENTITIES)("%s", async (entity) => {
    await seedWorld(ctx);
    const { fields, list } = GUARDS[entity];
    const baseline = new Set((await list(ctx.db, {})).ids);
    const violations: string[] = [];

    for (const [field, schema] of Object.entries(fields)) {
      if (!isPresenceField(field, schema as z.ZodType)) continue;
      const has = new Set((await list(ctx.db, { [field]: "has" })).ids);
      const none = new Set((await list(ctx.db, { [field]: "none" })).ids);
      const overlap = [...has].filter((id) => none.has(id));
      const union = new Set([...has, ...none]);
      const missing = [...baseline].filter((id) => !union.has(id));
      const extra = [...union].filter((id) => !baseline.has(id));
      if (overlap.length > 0 || missing.length > 0 || extra.length > 0) {
        violations.push(
          `${entity}.${field}: overlap=${overlap.length}, missing=${missing.length}, extra=${extra.length}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});
