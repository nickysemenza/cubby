import type { ReportBlock } from "@cubby/schemas/entity-report";
import { entityReportOut } from "@cubby/schemas/entity-report";
import { entityReportInput } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { buildEntityReport, buildEntityReports } from "./index";

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

  it("validates collection scopes and totals selected project roots once", async () => {
    const { output: parent } = await createRepoEntity(ctx, "project", {
      name: "Selected parent",
      costEstimate: 400,
    });
    const { output: child } = await createRepoEntity(ctx, "project", {
      name: "Selected child",
      parentProjectId: parent.id,
    });
    await createRepoEntity(ctx, "expense", {
      name: "Selected expense",
      cost: 125,
      future: false,
      costType: "materials",
      trade: "other",
      projectId: child.id,
    });
    const request = entityReportInput.parse({
      slot: "project.analytics",
      scope: {
        kind: "selection",
        entity: "project",
        ids: [parent.id, child.id],
      },
    });
    const result = await buildEntityReport(
      ctx.db,
      request,
      async () => null,
      ctx.actor,
    );
    const stats = blocksOf(result.blocks, "stats");
    expect(
      stats
        .flatMap((block) => block.figures)
        .find((figure) => figure.label === "Actual")?.value,
    ).toBe(125);
    const unsupported = entityReportInput.parse({
      slot: "project.budget",
      scope: { kind: "list", entity: "project", filters: {} },
    });
    await expect(
      buildEntityReport(ctx.db, unsupported, async () => null, ctx.actor),
    ).rejects.toThrow(/scope/iu);
    await expect(
      buildEntityReport(
        ctx.db,
        {
          ...request,
          scope: { kind: "selection", entity: "task", ids: [child.id] },
        },
        async () => null,
        ctx.actor,
      ),
    ).rejects.toThrow(/scope/iu);
    await expect(
      buildEntityReport(
        ctx.db,
        { ...request, cursor: "unexpected" },
        async () => null,
        ctx.actor,
      ),
    ).rejects.toThrow(/cursor/iu);
    await expect(
      buildEntityReport(
        ctx.db,
        {
          ...request,
          scope: {
            kind: "list",
            entity: "project",
            filters: { unsupported: true },
          },
        },
        async () => null,
        ctx.actor,
      ),
    ).rejects.toThrow(/unsupported/iu);
  });
  // A credit-only trade must remain visible when shared tables replace the specialized chart.
  it("discloses credit-only trade amounts in scoped analytics", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Credit-only work",
    });
    await createRepoEntity(ctx, "expense", {
      name: "Material credit",
      cost: -5,
      future: false,
      date: "2026-01-01",
      costType: "materials",
      trade: "other",
      projectId: project.id,
    });
    const result = await buildEntityReport(
      ctx.db,
      {
        slot: "project.analytics",
        scope: { kind: "selection", entity: "project", ids: [project.id] },
      },
      async () => null,
      ctx.actor,
    );
    const trade = blocksOf(result.blocks, "table").find(
      (block) => block.title === "Spend by trade",
    );
    expect(trade?.rows).toContainEqual(
      expect.objectContaining({
        cells: ["other", "$0.00", "$0.00", "-$5.00", "-$5.00", "1"],
      }),
    );
  });

  // The bounded next-task rows must still disclose ready work beyond their window.
  it("shows the remaining ready task count after the shared briefing window", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Ready work",
      defaultTrade: "building",
    });
    for (let index = 0; index < 5; index++) {
      await createRepoEntity(ctx, "task", {
        name: `Ready step ${index}`,
        projectId: project.id,
      });
    }
    const result = await buildEntityReport(
      ctx.db,
      {
        slot: "task.briefing",
        scope: { kind: "list", entity: "task", filters: {} },
      },
      async () => null,
      ctx.actor,
    );
    const [tasks] = blocksOf(result.blocks, "records");
    expect(tasks?.rows).toHaveLength(4);
    expect(tasks?.footer).toBe("1 more ready");
  });

  const report = async (
    slot: Parameters<typeof buildEntityReport>[1]["slot"],
    id: string,
  ) => {
    await drainStoredDerived(ctx.db);
    const out = await buildEntityReport(
      ctx.db,
      { slot, scope: { kind: "record", id: id } },
      async () => null,
      ctx.actor,
    );
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

    // Batch reuse must work in either requested order.
    for (const slots of [
      ["project.budget", "project.analytics"],
      ["project.analytics", "project.budget"],
    ] as const) {
      const batch = await buildEntityReports(
        ctx.db,
        { id: parent.id, slots: [...slots] },
        async () => null,
        ctx.actor,
      );
      expect(batch.reports.map(({ slot }) => slot)).toEqual(slots);
      expect(
        batch.reports.find(({ slot }) => slot === "project.budget")?.report
          .blocks,
      ).toEqual(blocks);
    }
  });

  it("explains an empty budget instead of drawing zeros", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Budget empty",
    });
    const blocks = await report("project.budget", project.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "note" });
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
    // An aggregated gap stands for many expenses: one row with a count, never
    // one link per record.
    expect(
      blocksOf(blocks, "table")
        .find((table) => table.title === "Attribution gaps")
        ?.rows.map((row) => row.cells),
    ).toContainEqual(["Committed, not yet paid", "$125.00", "1 expense"]);
  });

  it("values a location's contents and breaks direct stock down by brandName", async () => {
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Valuation bin", type: "shelf" }),
      ctx.actor,
    );
    const widget = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Valuation widget",
        price: 10,
        brandId: await findOrCreateVendor(ctx.db, "Acme Synthetic"),
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
      buildEntityReport(
        ctx.db,
        {
          slot: "project.budget",
          scope: {
            kind: "record",
            id: parseShortcodeFor("meal", meal.shortcode),
          },
        },
        async () => null,
        ctx.actor,
      ),
    ).rejects.toThrow(/project|prefix|shortcode/i);
  });
});
