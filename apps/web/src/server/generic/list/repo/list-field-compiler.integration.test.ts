import { createRepoEntity } from "tooling/factories/repo";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  inventoryentryList,
  inventoryentryListRead,
} from "~/server/domains/inventory/repo/crud";
import { projectList } from "~/server/domains/project/repo/lookup";
import { taskList } from "~/server/domains/task/repo/lookup";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

const page = { pageIndex: 0, pageSize: 50 };

/**
 * Declared list fields against real rows. Failure modes: a related path that
 * ends in a hierarchy matches only the selected record, ignores its toggle,
 * or sorts by something other than the related title; a subtree filter on
 * projects or tasks stops at direct children.
 */
describe("compiled list fields", () => {
  const ctx = withTestDb();

  it("filters and sorts inventory through product.category with descendants", async () => {
    const root = await createRepoEntity(ctx, "productCategory", {
      name: "Compiler outerwear",
    });
    const child = await createRepoEntity(ctx, "productCategory", {
      name: "Compiler anoraks",
      parentId: root.output.id,
    });
    const other = await createRepoEntity(ctx, "productCategory", {
      name: "Compiler blankets",
    });
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Compiler shelf",
        type: "shelf",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const stock = async (name: string, categoryId: typeof child.output.id) => {
      const item = await createProductFixture(
        ctx.db,
        makeProductInput({ name, categoryId }),
        ctx.actor,
      );
      return createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    };
    const anorak = await stock("Compiler anorak", child.output.id);
    const blanket = await stock("Compiler blanket", other.output.id);
    const ids = async (filters: Parameters<typeof inventoryentryList>[1]) =>
      (await inventoryentryList(ctx.db, filters, [], page)).data.map(
        (row) => row.id,
      );

    expect(await ids({ categoryFilter: [root.output.id] })).toEqual([
      anorak.id,
    ]);
    // Several selected roots seed the recursion together.
    expect(
      (await ids({ categoryFilter: [root.output.id, other.output.id] })).sort(),
    ).toEqual([anorak.id, blanket.id].sort());
    expect(
      await ids({
        categoryFilter: [root.output.id],
        includeSubProductCategories: false,
      }),
    ).toEqual([]);

    const sorted = await inventoryentryList(
      ctx.db,
      { categoryFilter: [child.output.id, other.output.id] },
      [{ orderBy: "category", direction: "desc" }],
      page,
    );
    expect(sorted.data.map((row) => row.id)).toEqual([blanket.id, anorak.id]);

    // A count skips the valuation prepare, so it must not build the derived
    // valuation ORDER BY that reads it.
    const counted = await inventoryentryListRead(
      ctx.db,
      { categoryFilter: [root.output.id] },
      [{ orderBy: "valuation", direction: "asc" }],
      page,
      { kind: "full" },
      "count",
    );
    expect(counted.count).toBe(1);
  });

  it("includes every level below a selected project", async () => {
    const parent = await createRepoEntity(ctx, "project", {
      name: "Compiler renovation",
    });
    const child = await createRepoEntity(ctx, "project", {
      name: "Compiler kitchen",
      parentProjectId: parent.output.id,
    });
    const grandchild = await createRepoEntity(ctx, "project", {
      name: "Compiler cabinets",
      parentProjectId: child.output.id,
    });
    const projects = await projectList(
      ctx.db,
      { parentProjectId: parent.output.id, includeSubProjects: true },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(projects.data.map((row) => row.id)).toEqual([
      grandchild.output.id,
      child.output.id,
    ]);

    const tasks = await Promise.all(
      [parent, child, grandchild].map((project) =>
        createRepoEntity(ctx, "task", {
          name: `Compiler task ${project.output.name}`,
          trade: "other",
          projectId: project.output.id,
        }),
      ),
    );
    const subtree = await taskList(
      ctx.db,
      { projectId: child.output.id, includeSubProjects: true },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(subtree.data.map((row) => row.id)).toEqual([
      tasks[2]!.output.id,
      tasks[1]!.output.id,
    ]);
  });
});
