import type { ReportBlock } from "@cubby/schemas/entity-report";
import { entityReportOut } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mealRecipe } from "~/server/db/schema";
import { insertAndReturn } from "~/server/repo/database-helpers";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { buildEntityReport } from "./index";

const blocksOf = <K extends ReportBlock["kind"]>(
  blocks: ReportBlock[],
  kind: K,
) =>
  blocks.filter(
    (block): block is Extract<ReportBlock, { kind: K }> => block.kind === kind,
  );

/**
 * Failure modes a detail-slot report can have: figures that disagree with the
 * Expense ledger (a future cost counted as actual, a credit counted as spend,
 * sub-project spend missing), a schedule that drops undated or nested rows or
 * loses dependency ids, a valuation that omits the direct breakdown, and a
 * report that accepts an id whose prefix does not match the slot's entity.
 */
describe("entity report", () => {
  const ctx = withTestDb("mcp");
  const report = async (
    slot: Parameters<typeof buildEntityReport>[1]["slot"],
    id: string,
  ) => {
    const out = await buildEntityReport(ctx.db, { slot, id });
    // The wire contract must accept what the builder produces.
    return entityReportOut.parse(out).blocks;
  };

  it("splits budget spend over the subtree into actual, committed and credits", async () => {
    const { output: parent } = await createRepoEntity(ctx, "project", {
      name: "Budget parent",
      costEstimate: 1000,
    });
    const { output: child } = await createRepoEntity(ctx, "project", {
      name: "Budget child",
      parentProjectId: parent.id,
    });
    for (const [projectId, cost, future] of [
      [parent.id, 200, false],
      [child.id, 100, false],
      [child.id, 50, true],
      [child.id, -30, false],
    ] as const) {
      await createRepoEntity(ctx, "expense", {
        name: `Budget fixture ${cost}`,
        cost,
        future,
        date: "2026-08-01",
        costType: "materials",
        trade: "other",
        projectId,
      });
    }

    const blocks = await report("project.budget", parent.id);
    const [stats] = blocksOf(blocks, "stats");
    const figure = (label: string) =>
      stats?.figures.find((entry) => entry.label === label)?.value;
    expect(figure("Estimate")).toBe(1000);
    expect(figure("Actual")).toBe(300);
    expect(figure("Committed")).toBe(50);
    expect(figure("Credits")).toBe(-30);
    // estimate - (actual + committed - credits)
    expect(figure("Remaining")).toBe(680);
    const [chart] = blocksOf(blocks, "chart");
    expect(chart).toMatchObject({ mark: "stack", marker: 1000 });
    expect(chart?.series.map((entry) => entry.value)).toEqual([300, 50]);
  });

  it("explains an empty budget instead of drawing zeros", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Budget empty",
    });
    const blocks = await report("project.budget", project.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "note" });
  });

  it("lists the schedule in tree order with undated rows and dependency ids", async () => {
    const { output: root } = await createRepoEntity(ctx, "project", {
      name: "Schedule root",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    const { output: child } = await createRepoEntity(ctx, "project", {
      name: "Schedule child",
      parentProjectId: root.id,
    });
    const { output: dated } = await createRepoEntity(ctx, "task", {
      name: "Schedule dated task",
      trade: "other",
      projectId: root.id,
      dueDate: "2026-09-10",
    });
    const { output: undated } = await createRepoEntity(ctx, "task", {
      name: "Schedule undated task",
      trade: "other",
      projectId: child.id,
    });

    const [schedule] = blocksOf(
      await report("project.schedule", root.id),
      "schedule",
    );
    expect(schedule?.rows.map((row) => [row.name, row.depth])).toEqual([
      ["Schedule root", 0],
      ["Schedule dated task", 1],
      ["Schedule child", 1],
      ["Schedule undated task", 2],
    ]);
    const byId = new Map(schedule?.rows.map((row) => [row.id, row]));
    expect(byId.get(dated.id)?.segments[0]).toMatchObject({
      startDate: "2026-09-10",
      variant: "milestone",
    });
    expect(byId.get(undated.id)).toMatchObject({
      segments: [],
      noDateLabel: "No due date",
    });
    expect(byId.get(root.id)).toMatchObject({
      expandable: true,
      segments: [{ startDate: "2026-09-01", endDate: "2026-09-30" }],
    });
  });

  it("charts spend analytics for the project subtree", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Analytics fixture",
    });
    await createRepoEntity(ctx, "expense", {
      name: "Analytics fixture expense",
      cost: 75,
      date: "2026-07-15",
      costType: "services",
      trade: "other",
      projectId: project.id,
    });
    const blocks = await report("project.analytics", project.id);
    const [stats] = blocksOf(blocks, "stats");
    expect(stats?.figures.find((entry) => entry.label === "Net")?.value).toBe(
      75,
    );
    const monthly = blocksOf(blocks, "chart").find(
      (chart) => chart.title === "By month",
    );
    expect(monthly?.series).toEqual([
      expect.objectContaining({ label: "2026-07", value: 75 }),
    ]);
  });

  it("reports the contribution split with whole-group cost", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Contribution fixture",
    });
    await createRepoEntity(ctx, "expense", {
      name: "Contribution fixture expense",
      cost: 125,
      future: true,
      date: "2026-08-01",
      costType: "materials",
      trade: "other",
      projectId: project.id,
    });
    const blocks = await report("project.contribution", project.id);
    const [stats] = blocksOf(blocks, "stats");
    expect(
      stats?.figures.find((entry) => entry.label === "Whole-group cost")?.value,
    ).toBe(125);
    expect(
      blocksOf(blocks, "table").find((table) => table.title?.includes("gaps"))
        ?.rows.length,
    ).toBeGreaterThan(0);
  });

  it("values a location's contents and breaks direct stock down by manufacturer", async () => {
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Valuation bin", type: "shelf" }),
      ctx.actor,
    );
    const widget = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Valuation widget",
        price: 10,
        manufacturer: "Acme Synthetic",
      }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: widget.id,
        locationId: bin.id,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    const blocks = await report("location.contents-valuation", bin.id);
    const [stats] = blocksOf(blocks, "stats");
    expect(
      stats?.figures.find((entry) => entry.label === "Total value")?.value,
    ).toBe(30);
    const [table] = blocksOf(blocks, "table");
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ["Acme Synthetic", "$30.00"],
    ]);
  });

  it("groups direct stock by manufacturer in SQL, largest first, capped, ignoring unpriced and other places", async () => {
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Group bin", type: "shelf" }),
      ctx.actor,
    );
    const elsewhere = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Group elsewhere", type: "shelf" }),
      ctx.actor,
    );
    const stock = async (
      name: string,
      manufacturer: string | undefined,
      price: number | undefined,
      quantity: number,
      where = bin,
    ) => {
      const sku = await createProductFixture(
        ctx.db,
        makeProductInput({ name, price, manufacturer }),
        ctx.actor,
      );
      await createInventoryFixture(
        ctx.db,
        {
          productId: sku.id,
          locationId: where.id,
          amount: { value: quantity, unit: "each" },
        },
        ctx.actor,
      );
    };
    for (let index = 1; index <= 7; index += 1)
      await stock(`Group item ${index}`, `Maker ${index}`, 10 * index, 1);
    await stock("Group second", "Maker 7", 5, 2);
    await stock("Group unpriced", "Maker unpriced", undefined, 1);
    await stock("Group other place", "Maker elsewhere", 999, 1, elsewhere);

    const [table] = blocksOf(
      await report("location.contents-valuation", bin.id),
      "table",
    );
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ["Maker 7", "$80.00"],
      ["Maker 6", "$60.00"],
      ["Maker 5", "$50.00"],
      ["Maker 4", "$40.00"],
      ["Maker 3", "$30.00"],
      ["Maker 2", "$20.00"],
    ]);
  });

  it("lists a meal's recipes with their scale", async () => {
    const meal = await insertWithShortcode(ctx.db, "meal", {
      date: "2026-09-14",
      name: "Composition fixture",
    });
    const recipe = await insertWithShortcode(ctx.db, "recipe", {
      name: "Synthetic stew",
    });
    await insertAndReturn(ctx.db, mealRecipe, {
      mealId: meal.id,
      recipeId: recipe.id,
      scale: 2,
    });
    const [table] = blocksOf(
      await report(
        "meal.composition",
        parseShortcodeFor("meal", meal.shortcode),
      ),
      "table",
    );
    expect(table?.rows).toHaveLength(1);
    expect(table?.rows[0]?.cells.slice(0, 2)).toEqual(["Synthetic stew", "×2"]);
    expect(table?.rows[0]?.ref).toMatchObject({ entity: "recipe" });
  });

  it("keeps unpriced expenses visible instead of reading them as $0", async () => {
    const unpriced = (projectId: string, name: string) =>
      createRepoEntity(ctx, "expense", {
        name,
        cost: null,
        date: "2026-08-01",
        costType: "materials",
        trade: "other",
        projectId,
      });
    const { output: onlyUnpriced } = await createRepoEntity(ctx, "project", {
      name: "Unpriced only",
    });
    await unpriced(onlyUnpriced.id, "Unpriced fixture one");
    const only = await report("project.budget", onlyUnpriced.id);
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ kind: "note" });
    expect(only[0]).toMatchObject({
      text: expect.stringContaining("1 expense"),
    });
    expect(blocksOf(only, "stats")).toEqual([]);

    const { output: mixed } = await createRepoEntity(ctx, "project", {
      name: "Unpriced mixed",
      costEstimate: 500,
    });
    await unpriced(mixed.id, "Unpriced fixture two");
    await createRepoEntity(ctx, "expense", {
      name: "Priced fixture",
      cost: 40,
      date: "2026-08-02",
      costType: "materials",
      trade: "other",
      projectId: mixed.id,
    });
    for (const slot of ["project.budget", "project.analytics"] as const) {
      const blocks = await report(slot, mixed.id);
      expect(blocksOf(blocks, "stats")).toHaveLength(1);
      expect(
        blocksOf(blocks, "note").some((note) =>
          note.text.includes("1 expense"),
        ),
      ).toBe(true);
    }
  });

  it("budgets only a project's allocated share of a shared purchase adjustment", async () => {
    const { output: a } = await createRepoEntity(ctx, "project", {
      name: "Shared purchase A",
    });
    const { output: b } = await createRepoEntity(ctx, "project", {
      name: "Shared purchase B",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Shared purchase vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-10",
    });
    const line = (
      name: string,
      cost: number,
      lineKind: "principal" | "shipping",
      projectId?: string,
    ) =>
      createRepoEntity(ctx, "expense", {
        name,
        cost,
        date: "2026-08-10",
        costType: "materials",
        trade: "other",
        purchaseId: purchase.shortcode,
        lineKind,
        projectId: projectId ?? null,
      });
    await line("Shared principal A", 100, "principal", a.id);
    await line("Shared principal B", 300, "principal", b.id);
    await line("Shared shipping", 40, "shipping");

    const budget = async (id: string) =>
      blocksOf(await report("project.budget", id), "stats")[0]?.figures.find(
        (figure) => figure.label === "Actual",
      )?.value;
    // The shipping splits 1:3 by principal weight; each project sees only its share.
    expect(await budget(a.id)).toBe(110);
    expect(await budget(b.id)).toBe(330);
  });

  it("refuses an id whose prefix is not the slot's entity", async () => {
    const meal = await insertWithShortcode(ctx.db, "meal", {
      date: "2026-09-14",
      name: "Wrong entity fixture",
    });
    await expect(
      buildEntityReport(ctx.db, {
        slot: "project.budget",
        id: parseShortcodeFor("meal", meal.shortcode),
      }),
    ).rejects.toThrow(/project|prefix|shortcode/i);
  });
});
