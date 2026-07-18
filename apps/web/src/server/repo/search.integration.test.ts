import {
  projectCreateInput,
  purchaseCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { createProject } from "~/server/repo/project";
import { createPurchase } from "~/server/repo/purchase";
import { createTask } from "~/server/repo/task";
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
          category: "carpentry",
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
      expect(hit.typeHint).toBe("carpentry");
    }
  });

  it("finds a task by category text", async () => {
    const task = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Category Search Task",
          category: "manifest-category-plumbing",
        },
      }),
      ctx.actor,
    );

    const results = await globalSearch(ctx.db, "manifest-category-plumbing");
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

  it("finds a purchase by subcategory or notes text", async () => {
    const bySubcategory = await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
        overrides: {
          name: "Subcategory Search Purchase",
          subcategory: "manifest-subcategory-lumber",
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

    const subcategoryResults = await globalSearch(
      ctx.db,
      "manifest-subcategory-lumber",
    );
    expect(
      subcategoryResults.some(
        (r) => r.entityType === "purchase" && r.id === bySubcategory.id,
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
