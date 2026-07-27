import {
  projectCreateInput,
  purchaseCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { deleteCookbook, upsertCookbook } from "~/server/repo/cookbook";
import { createMeal, deleteMeals } from "~/server/repo/meal";
import { createProject } from "~/server/repo/project";
import { createPurchase } from "~/server/repo/purchase";
import { createRecipe, deleteRecipes } from "~/server/repo/recipe";
import { createTask } from "~/server/repo/task";
import { makeRecipeInput } from "./repo.fixtures";
import { globalSearch, hydrateSearchResultsByRefs } from "./search";

// Lexical-search + ref-hydration coverage for the tracker entities (project,
// task, purchase), which mirror the pattern already exercised for
// product/recipe/ingredient/location/inventory in
// soft-delete-recipe-consistency.integration.test.ts.

describe("globalSearch: tracker entities", () => {
  const ctx = withTestDb();

  it("finds a project by name and reports status + spent enrichment", async () => {
    const project = await createProject(
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
    await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
        overrides: {
          name: "Manifest wire spool",
          cost: 42.5,
          projectId: project.id,
          future: false,
        },
      }),
      ctx.actor,
    );
    // A second, planned purchase — spent sums ALL live purchases (including
    // future ones), matching projectRollups' semantics.
    await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
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
  });

  it("finds a project by notes text", async () => {
    const project = await createProject(
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
    const project = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Manifest Task Project" },
      }),
      ctx.actor,
    );
    const task = await createTask(
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
    const task = await createTask(
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

  it("finds a purchase by name and reports cost + projectName enrichment", async () => {
    const project = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Manifest Purchase Project" },
      }),
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
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
      (r) => r.entityType === "purchase" && r.id === purchase.id,
    );
    expect(hit).toBeDefined();
    if (hit?.entityType === "purchase") {
      expect(hit.cost).toBeCloseTo(129.99);
      expect(hit.projectName).toBe("Manifest Purchase Project");
      expect(hit.subtitle).toBe("Manifest Purchase Project");
    }
  });

  it("finds a purchase by trade or notes text", async () => {
    const byTrade = await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
        overrides: {
          name: "Trade Search Purchase",
          trade: "electrical",
        },
      }),
      ctx.actor,
    );
    const byNotes = await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
        overrides: {
          name: "Notes Search Purchase",
          notes: "manifest-notes-hardware-store-receipt",
        },
      }),
      ctx.actor,
    );

    const tradeResults = await globalSearch(ctx.db, "electrical");
    expect(
      tradeResults.some(
        (r) => r.entityType === "purchase" && r.id === byTrade.id,
      ),
    ).toBe(true);

    const notesResults = await globalSearch(
      ctx.db,
      "manifest-notes-hardware-store-receipt",
    );
    expect(
      notesResults.some(
        (r) => r.entityType === "purchase" && r.id === byNotes.id,
      ),
    ).toBe(true);
  });
});

// Cookbook + meal became searchable alongside the tracker entities; the same
// lexical branch/ref-hydration contract applies to them.
describe("globalSearch: cookbook and meal", () => {
  const ctx = withTestDb();

  it("finds a cookbook by title, author, and subject", async () => {
    const cookbook = await upsertCookbook(
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
    const cookbook = await upsertCookbook(
      ctx.db,
      {
        name: "Manifest Deleted Cookbook",
        rawJson: [],
        sourceLabel: "manifest-deleted.epub",
      },
      ctx.actor,
    );
    await deleteCookbook(ctx.db, cookbook.id, ctx.actor);

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
    await deleteRecipes(ctx.db, [drop.id], ctx.actor);

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
    const meal = await createMeal(
      ctx.db,
      { date: "2026-05-05", name: "Manifest Deleted Meal" },
      ctx.actor,
    );
    await deleteMeals(ctx.db, [meal.id], ctx.actor);

    const results = await globalSearch(ctx.db, "Manifest Deleted Meal");
    expect(
      results.some((r) => r.entityType === "meal" && r.id === meal.id),
    ).toBe(false);
  });
});

describe("hydrateSearchResultsByRefs: tracker entities", () => {
  const ctx = withTestDb();

  it("round-trips project/task/purchase refs, preserving ref order", async () => {
    const project = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Hydrate Ref Project" },
      }),
      ctx.actor,
    );
    const task = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Hydrate Ref Task", projectId: project.id },
      }),
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
        overrides: { name: "Hydrate Ref Purchase", projectId: project.id },
      }),
      ctx.actor,
    );

    const results = await hydrateSearchResultsByRefs(ctx.db, [
      { entityType: "purchase", entityId: purchase.id },
      { entityType: "project", entityId: project.id },
      { entityType: "task", entityId: task.id },
    ]);

    expect(results.map((r) => r.entityType)).toEqual([
      "purchase",
      "project",
      "task",
    ]);
    expect(results.map((r) => r.id)).toEqual([
      purchase.id,
      project.id,
      task.id,
    ]);
    const taskHit = results.find((r) => r.entityType === "task");
    if (taskHit?.entityType === "task") {
      expect(taskHit.projectName).toBe("Hydrate Ref Project");
    }
    const purchaseHit = results.find((r) => r.entityType === "purchase");
    if (purchaseHit?.entityType === "purchase") {
      expect(purchaseHit.projectName).toBe("Hydrate Ref Project");
    }
  });

  it("drops refs that don't resolve to a live row", async () => {
    const project = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Hydrate Missing Ref Project" },
      }),
      ctx.actor,
    );

    const results = await hydrateSearchResultsByRefs(ctx.db, [
      { entityType: "project", entityId: project.id },
      {
        entityType: "task",
        entityId: "00000000-0000-4000-8000-000000000000",
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.entityType).toBe("project");
  });
});
