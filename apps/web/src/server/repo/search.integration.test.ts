import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { globalSearchOut } from "@cubby/schemas/search";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { deleteCookbook, upsertCookbook } from "~/server/repo/cookbook";
import { createExpense } from "~/server/repo/expense";
import { createFinancialAccount } from "~/server/repo/financial-account";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import {
  createMeal,
  createMealWithEntityId,
  deleteMeals,
} from "~/server/repo/meal";
import { createProject } from "~/server/repo/project";
import { createPurchase } from "~/server/repo/purchase";
import { createRecipe, deleteRecipes } from "~/server/repo/recipe";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTask } from "~/server/repo/task";
import { createVendor } from "~/server/repo/vendor";
import { makeRecipeInput } from "./repo.fixtures";
import { globalSearch, hydrateSearchResultsByRefs } from "./search";

// Lexical-search + ref-hydration coverage for the tracker entities (project,
// task, expense), which mirror the pattern already exercised for
// product/recipe/ingredient/location/inventory in
// soft-delete-recipe-consistency.integration.test.ts.

describe("globalSearch: tracker entities", () => {
  const ctx = withTestDb();

  it("finds a project by name and reports status + spent enrichment", async () => {
    const { output: project } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: {
          name: "Garage Rewire Manifest",
          status: "in_progress",
          kind: "renovation",
          notes: null,
        },
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Manifest wire spool",
          cost: 42.5,
          projectId: project.id,
          future: false,
        },
      }),
      ctx.actor,
    );
    // A second, planned expense — spent sums ALL live expenses (including
    // future ones), matching projectRollups' semantics.
    await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Manifest breaker panel",
          cost: 100,
          projectId: project.id,
          future: true,
        },
      }),
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "Garage Rewire Manifest");
    const hit = results.find(
      (r) => r.entityType === "project" && r.id === project.id,
    );
    expect(hit).toBeDefined();
    expect(hit?.entityType).toBe("project");
    if (hit?.entityType === "project") {
      expect(hit.status).toBe("in_progress");
      expect(hit.spent).toBeCloseTo(142.5);
      expect(hit.subtitle).toBe("renovation");
      expect(hit.typeHint).toBe("in_progress");
    }
    const publicHit = globalSearchOut
      .parse(results)
      .find((row) => row.entityType === "project" && row.id === project.id);
    expect(publicHit).not.toHaveProperty("entityId");
    expect(publicHit).not.toHaveProperty("shortcode");
  });

  it("finds a project by notes text", async () => {
    const { output: project } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: {
          name: "Notes Search Project",
          notes: "Replace the fence boards along the manifest-notes-fence",
        },
      }),
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "manifest-notes-fence");
    expect(
      results.some((r) => r.entityType === "project" && r.id === project.id),
    ).toBe(true);
  });

  it("finds a task by name and reports status + projectName enrichment", async () => {
    const { output: project } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Manifest Task Project" },
      }),
      ctx.actor,
    );
    const { output: task } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Manifest Sand The Deck",
          status: "in_progress",
          trade: "finishes",
          projectId: project.id,
        },
      }),
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "Manifest Sand The Deck");
    const hit = results.find(
      (r) => r.entityType === "task" && r.id === task.id,
    );
    expect(hit).toBeDefined();
    if (hit?.entityType === "task") {
      expect(hit.status).toBe("in_progress");
      expect(hit.projectName).toBe("Manifest Task Project");
      expect(hit.subtitle).toBe("Manifest Task Project");
      expect(hit.typeHint).toBe("finishes");
    }
  });

  it("finds a task by trade text", async () => {
    const { output: task } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Trade Search Task",
          trade: "plumbing",
        },
      }),
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "plumbing");
    expect(
      results.some((r) => r.entityType === "task" && r.id === task.id),
    ).toBe(true);
  });

  it("finds an expense by name and reports cost + projectName enrichment", async () => {
    const { output: project } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Manifest Expense Project" },
      }),
      ctx.actor,
    );
    const { output: expense } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Manifest Cordless Drill",
          cost: 129.99,
          projectId: project.id,
        },
      }),
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "Manifest Cordless Drill");
    const hit = results.find(
      (r) => r.entityType === "expense" && r.id === expense.id,
    );
    expect(hit).toBeDefined();
    if (hit?.entityType === "expense") {
      expect(hit.cost).toBeCloseTo(129.99);
      expect(hit.projectName).toBe("Manifest Expense Project");
      expect(hit.subtitle).toBe("Manifest Expense Project");
    }
  });

  it("finds an expense by trade or notes text", async () => {
    const { output: byTrade } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Trade Search Expense",
          trade: "electrical",
        },
      }),
      ctx.actor,
    );
    const { output: byNotes } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Notes Search Expense",
          notes: "manifest-notes-hardware-store-receipt",
        },
      }),
      ctx.actor,
    );

    const tradeResults = await globalSearch(ctx.db, "electrical");
    expect(
      tradeResults.some(
        (r) => r.entityType === "expense" && r.id === byTrade.id,
      ),
    ).toBe(true);

    const notesResults = await globalSearch(
      ctx.db,
      "manifest-notes-hardware-store-receipt",
    );
    expect(
      notesResults.some(
        (r) => r.entityType === "expense" && r.id === byNotes.id,
      ),
    ).toBe(true);
  });
});

// Cookbook + meal became searchable alongside the tracker entities; the same
// lexical branch/ref-hydration contract applies to them.
describe("globalSearch: cookbook and meal", () => {
  const ctx = withTestDb();

  it("finds a cookbook by title, author, and subject", async () => {
    const { output: cookbook } = await upsertCookbook(
      ctx.db,
      {
        name: "Manifest Book Of Braises",
        rawJson: [],
        author: ["Manifesta Braisewright"],
        subjects: ["manifest-subject-stews"],
        sourceLabel: "manifest-braises.epub",
      },
      ctx.actor,
    );

    const byTitle = await globalSearch(ctx.db, "Manifest Book Of Braises");
    const hit = byTitle.find(
      (r) => r.entityType === "cookbook" && r.id === cookbook.id,
    );
    expect(hit).toBeDefined();
    if (hit?.entityType === "cookbook") {
      expect(hit.name).toBe("Manifest Book Of Braises");
      expect(hit.subtitle).toBe("Manifesta Braisewright");
      expect(hit.authors).toEqual(["Manifesta Braisewright"]);
      expect(hit.recipeCount).toBe(0);
    }

    for (const term of ["Manifesta Braisewright", "manifest-subject-stews"]) {
      const results = await globalSearch(ctx.db, term);
      expect(
        results.some(
          (r) => r.entityType === "cookbook" && r.id === cookbook.id,
        ),
      ).toBe(true);
    }
  });

  it("excludes a soft-deleted cookbook", async () => {
    const { output: cookbook, entityId: cookbookUuid } = await upsertCookbook(
      ctx.db,
      {
        name: "Manifest Deleted Cookbook",
        rawJson: [],
        sourceLabel: "manifest-deleted.epub",
      },
      ctx.actor,
    );
    await deleteCookbook(ctx.db, cookbookUuid, ctx.actor);

    const results = await globalSearch(ctx.db, "Manifest Deleted Cookbook");
    expect(
      results.some((r) => r.entityType === "cookbook" && r.id === cookbook.id),
    ).toBe(false);
  });

  it("finds a meal by name, by date, and by a planned recipe's name", async () => {
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Manifest Cassoulet" }),
      ctx.actor,
    );
    const meal = await createMeal(
      ctx.db,
      {
        date: "2026-03-14",
        name: "Manifest Sunday Supper",
        recipes: [{ recipeId: recipe.id, scale: 1 }],
      },
      ctx.actor,
    );

    const byName = await globalSearch(ctx.db, "Manifest Sunday Supper");
    const hit = byName.find((r) => r.entityType === "meal" && r.id === meal.id);
    expect(hit).toBeDefined();
    if (hit?.entityType === "meal") {
      expect(hit.name).toBe("Manifest Sunday Supper");
      expect(hit.date).toBe("2026-03-14");
      expect(hit.subtitle).toBe("2026-03-14");
      expect(hit.recipeCount).toBe(1);
    }

    // The date string and the planned recipe's name are both match surfaces.
    for (const term of ["2026-03-14", "Manifest Cassoulet"]) {
      const results = await globalSearch(ctx.db, term);
      expect(
        results.some((r) => r.entityType === "meal" && r.id === meal.id),
      ).toBe(true);
    }
  });

  it("stops counting a planned recipe once that recipe is deleted", async () => {
    const [keep, drop] = await Promise.all([
      createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Manifest Keeper" }),
        ctx.actor,
      ),
      createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Manifest Dropped" }),
        ctx.actor,
      ),
    ]);
    const meal = await createMeal(
      ctx.db,
      {
        date: "2026-03-21",
        name: "Manifest Shrinking Supper",
        recipes: [
          { recipeId: keep.id, scale: 1 },
          { recipeId: drop.id, scale: 1 },
        ],
      },
      ctx.actor,
    );

    // Deleting a recipe soft-deletes the recipe but leaves its MealRecipe rows,
    // so recipeCount must join Recipe rather than count the join table alone.
    const dropEntityId = await resolveLiveShortcode(ctx.db, drop.id, "recipe");
    expect(dropEntityId).not.toBeNull();
    await deleteRecipes(
      ctx.db,
      [unsafeRecipeId(dropEntityId as string)],
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "Manifest Shrinking Supper");
    const hit = results.find(
      (r) => r.entityType === "meal" && r.id === meal.id,
    );
    expect(hit).toBeDefined();
    if (hit?.entityType === "meal") {
      expect(hit.recipeCount).toBe(1);
    }
  });

  it("falls back to the date as the display name for an unnamed meal", async () => {
    const meal = await createMeal(
      ctx.db,
      { date: "2026-04-02", name: null },
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "2026-04-02");
    const hit = results.find(
      (r) => r.entityType === "meal" && r.id === meal.id,
    );
    expect(hit?.name).toBe("2026-04-02");
  });

  it("excludes a soft-deleted meal", async () => {
    const { output: meal, entityId: mealEntityId } =
      await createMealWithEntityId(
        ctx.db,
        { date: "2026-05-05", name: "Manifest Deleted Meal" },
        ctx.actor,
      );
    await deleteMeals(ctx.db, [mealEntityId], ctx.actor);

    const results = await globalSearch(ctx.db, "Manifest Deleted Meal");
    expect(
      results.some((r) => r.entityType === "meal" && r.id === meal.id),
    ).toBe(false);
  });
});

describe("hydrateSearchResultsByRefs: tracker entities", () => {
  const ctx = withTestDb();

  it("round-trips project/task/expense refs, preserving ref order", async () => {
    // `hydrateSearchResultsByRefs` takes the private uuid on purpose — its refs
    // come straight off the search index rows, which are uuid-keyed.
    const { output: project, entityId: projectUuid } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Hydrate Ref Project", icon: "🔨" },
      }),
      ctx.actor,
    );
    const { output: task, entityId: taskUuid } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Hydrate Ref Task", projectId: project.id },
      }),
      ctx.actor,
    );
    const { output: expense, entityId: expenseUuid } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: { name: "Hydrate Ref Expense", projectId: project.id },
      }),
      ctx.actor,
    );

    const results = await hydrateSearchResultsByRefs(ctx.db, [
      { entityType: "expense", entityId: expenseUuid },
      { entityType: "project", entityId: projectUuid },
      { entityType: "task", entityId: taskUuid },
    ]);

    expect(results.map((r) => r.entityType)).toEqual([
      "expense",
      "project",
      "task",
    ]);
    expect(results.map((r) => r.id)).toEqual([expense.id, project.id, task.id]);
    expect(results.map((r) => r.entityId)).toEqual([
      expenseUuid,
      projectUuid,
      taskUuid,
    ]);
    const projectHit = results.find((r) => r.entityType === "project");
    if (projectHit?.entityType === "project") {
      expect(projectHit.icon).toBe("🔨");
    }
    const taskHit = results.find((r) => r.entityType === "task");
    if (taskHit?.entityType === "task") {
      expect(taskHit.projectName).toBe("Hydrate Ref Project");
    }
    const expenseHit = results.find((r) => r.entityType === "expense");
    if (expenseHit?.entityType === "expense") {
      expect(expenseHit.projectName).toBe("Hydrate Ref Project");
    }
  });

  it("drops refs that don't resolve to a live row", async () => {
    const { entityId: projectUuid } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Hydrate Missing Ref Project" },
      }),
      ctx.actor,
    );

    const results = await hydrateSearchResultsByRefs(ctx.db, [
      { entityType: "project", entityId: projectUuid },
      {
        entityType: "task",
        entityId: "00000000-0000-4000-8000-000000000000",
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.entityType).toBe("project");
  });
});

describe("globalSearch: commercial and finance entities", () => {
  const ctx = withTestDb();

  it("finds and hydrates vendors, purchases, accounts, and transactions", async () => {
    const vendor = await createVendor(
      ctx.db,
      {
        name: "Finance Search Vendor",
        website: "https://finance-search-vendor.example",
        orderUrlTemplate: null,
        notes: null,
      },
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      {
        vendorId: vendor.output.id,
        orderId: "FINANCE-ORDER-MARKER",
        displayLabel: "pocket hole jig marker",
        date: "2026-06-15",
        statedTotal: 99,
        notes: "finance-purchase-notes-marker",
      },
      ctx.actor,
    );
    const account = await createFinancialAccount(
      ctx.db,
      {
        name: "Finance Search Account",
        identity: {
          kind: "credit_card",
          issuer: "Marker Bank",
          network: "visa",
          last4: "4242",
        },
        provisional: false,
        sourceAliases: [
          {
            source: "search-test",
            alias: "finance-account-alias-marker",
            externalAccountId: null,
          },
        ],
        notes: null,
      },
      ctx.actor,
    );
    const transaction = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        purchaseId: purchase.output.id,
        kind: "purchase",
        status: "pending",
        amount: 99,
        merchant: "Finance Search Merchant",
        rawDescription: "finance-transaction-description-marker",
      }),
      ctx.actor,
    );

    const cases = [
      ["Finance Search Vendor", "vendor", vendor.output.id],
      ["FINANCE-ORDER-MARKER", "purchase", purchase.output.id],
      ["pocket hole jig marker", "purchase", purchase.output.id],
      ["finance-account-alias-marker", "financialAccount", account.output.id],
      [
        "finance-transaction-description-marker",
        "financialTransaction",
        transaction.output.id,
      ],
    ] as const;
    for (const [term, entityType, id] of cases) {
      const results = globalSearchOut.parse(await globalSearch(ctx.db, term));
      expect(results).toContainEqual(
        expect.objectContaining({ entityType, id }),
      );
    }

    const hydrated = await hydrateSearchResultsByRefs(ctx.db, [
      { entityType: "financialTransaction", entityId: transaction.entityId },
      { entityType: "financialAccount", entityId: account.entityId },
      { entityType: "purchase", entityId: purchase.entityId },
      { entityType: "vendor", entityId: vendor.entityId },
    ]);
    expect(hydrated.map((row) => row.entityType)).toEqual([
      "financialTransaction",
      "financialAccount",
      "purchase",
      "vendor",
    ]);
    expect(hydrated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "vendor",
          purchaseCount: 1,
          spend: 0,
        }),
        expect.objectContaining({
          entityType: "purchase",
          name: "FINANCE-ORDER-MARKER (pocket hole jig marker)",
          expenseCount: 0,
          expenseTotal: 0,
        }),
        expect.objectContaining({
          entityType: "financialAccount",
          transactionCount: 1,
        }),
        expect.objectContaining({
          entityType: "financialTransaction",
          amount: 99,
          accountName: "Finance Search Account",
        }),
      ]),
    );
  });
});
