import {
  cashFlowProjectionInput,
  type CashFlowProjectionInput,
} from "@cubby/schemas/cash-flow";
import type { ProjectId, SpendingCategoryId } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { project } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { cashFlowProjection } from "./projection";

// Current month 2026-10; the baseline window is 2025-10-01..2026-09-30.
const TODAY = "2026-10-17";
const ctx = withTestDb();

const spend = (
  name: string,
  cost: number,
  date: string,
  links: {
    spendingCategoryId?: SpendingCategoryId;
    projectId?: ProjectId;
    future?: boolean;
  } = {},
) =>
  insertWithShortcode(ctx.db, "expense", {
    name: `synthetic cash flow ${name}`,
    cost,
    date,
    lineKind: "principal",
    costType: "materials",
    trade: "other",
    future: links.future ?? false,
    ...(links.spendingCategoryId
      ? { spendingCategoryId: links.spendingCategoryId }
      : {}),
    ...(links.projectId ? { projectId: links.projectId } : {}),
  });

const projectRow = (
  name: string,
  fields: Partial<typeof project.$inferInsert> = {},
) =>
  insertWithShortcode(ctx.db, "project", {
    name: `Synthetic ${name}`,
    status: "in_progress",
    ...fields,
  });

/**
 * Regular root: 6 of 12 months at $100 (one on the Household project), so
 * the median is $50 only when empty months count as zero, Household spend
 * counts, and other-project spend does not. Two sparse roots are Irregular.
 */
const fixture = async () => {
  const [household] = await getDb(ctx.db)
    .insert(project)
    .values({
      shortcode: testShortcode("project", "PRJ-HSHD"),
      name: "Household project",
      status: "in_progress",
      costEstimate: 9000,
    })
    .returning({ id: project.id });
  const regular = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic regular root",
  });
  const regularChild = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic regular child",
    parentId: regular.id,
  });
  const sparse = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic sparse root",
  });
  const rare = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic rare root",
  });

  const renovation = await projectRow("renovation", {
    costEstimate: 1000,
    endDate: "2027-01-31",
  });
  const longRun = await projectRow("long run", {
    costEstimate: 1200,
    endDate: "2027-11-30",
  });
  const unscheduled = await projectRow("unscheduled", { costEstimate: 400 });
  await projectRow("planning without estimate", { status: "planning" });
  const notStarted = await projectRow("not started", {
    status: "not_started",
    costEstimate: 600,
    endDate: "2027-03-31",
  });
  await projectRow("covered child", {
    costEstimate: 100,
    endDate: "2027-01-31",
    parentProjectId: renovation.id,
  });

  for (const month of ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"])
    await spend(`regular ${month}`, 100, `${month}-10`, {
      spendingCategoryId: regularChild.id,
    });
  await spend("household regular", 100, "2026-04-10", {
    spendingCategoryId: regular.id,
    projectId: household!.id,
  });
  // Project spend is the project's envelope, never baseline.
  await spend("renovation actual", 500, "2026-05-10", {
    spendingCategoryId: regular.id,
    projectId: renovation.id,
  });
  // Outside the trailing complete months.
  await spend("current month", 1000, "2026-10-05", {
    spendingCategoryId: regular.id,
  });
  await spend("before window", 1000, "2025-09-30", {
    spendingCategoryId: regular.id,
  });

  await spend("sparse a", 120, "2026-02-10", { spendingCategoryId: sparse.id });
  await spend("sparse b", 240, "2026-06-10", { spendingCategoryId: sparse.id });
  await spend("rare", 50, "2026-08-10", { spendingCategoryId: rare.id });

  // Committed: a project's own (subtracted from its envelope), an overdue
  // one inside the window (never baseline), and one past the horizon.
  await spend("renovation committed", 200, "2026-12-10", {
    projectId: renovation.id,
    future: true,
  });
  await spend("overdue committed", 80, "2026-08-15", {
    spendingCategoryId: regular.id,
    future: true,
  });
  await spend("far committed", 999, "2028-01-01", { future: true });

  return {
    regular,
    sparse,
    rare,
    renovation,
    longRun,
    unscheduled,
    notStarted,
  };
};

const project6 = (input: Partial<CashFlowProjectionInput> = {}) =>
  cashFlowProjection(
    ctx.db,
    cashFlowProjectionInput.parse({ horizonMonths: 6, ...input }),
    TODAY,
  );

describe("cashFlowProjection", () => {
  it("builds the baseline from Household and no-project spend with empty months as zero", async () => {
    const { regular } = await fixture();
    const out = await project6({ irregular: "separate" });
    expect(out.currentMonth).toBe("2026-10");
    expect(out.baselineWindow).toEqual({
      from: "2025-10-01",
      to: "2026-09-30",
    });
    const row = out.baseline.find((entry) => entry.key === regular.shortcode);
    expect(row).toMatchObject({
      irregular: false,
      activeMonths: 6,
      trailingTotal: 600,
      monthly: 50,
    });
    expect(row?.ledgerFilter).toMatchObject({
      spendingCategory: regular.shortcode,
      includeSubSpendingCategories: "true",
      dateFrom: "2025-10-01",
      dateTo: "2026-09-30",
      future: "false",
    });
  });

  it("carries Irregular categories at their mean and reconciles both modes", async () => {
    const { sparse, rare } = await fixture();
    const separate = await project6({ irregular: "separate" });
    const grouped = await project6({ irregular: "grouped" });
    expect(
      separate.baseline
        .filter((row) => row.irregular)
        .map((row) => [row.key, row.monthly])
        .sort(),
    ).toEqual(
      [
        [rare.shortcode, 4.17],
        [sparse.shortcode, 30],
      ].sort(),
    );
    expect(grouped.baseline.filter((row) => row.irregular)).toEqual([
      expect.objectContaining({
        key: "irregular",
        monthly: 34.17,
        trailingTotal: 410,
        activeMonths: 3,
        ledgerFilter: null,
      }),
    ]);
    expect(grouped.totals.baselineMonthly).toBe(84.17);
    expect(separate.totals).toEqual(grouped.totals);
    expect(grouped.months.map((month) => month.outflow)).toEqual(
      separate.months.map((month) => month.outflow),
    );
  });

  it("spreads envelopes, reports unscheduled and beyond-horizon remainders, and never double-counts committed", async () => {
    const { renovation, longRun, unscheduled, notStarted } = await fixture();
    const out = await project6();
    expect(out.months.map((month) => month.month)).toEqual([
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
    ]);
    // Only counted projects; Household, the covered child, the estimate-less
    // planning project, and not_started (toggle off) stay out.
    expect(out.envelopes.map((envelope) => envelope.id).sort()).toEqual(
      [renovation.shortcode, longRun.shortcode].sort(),
    );
    const renovationEnvelope = out.envelopes.find(
      (envelope) => envelope.id === renovation.shortcode,
    );
    expect(renovationEnvelope).toMatchObject({
      estimate: 1000,
      actual: 500,
      committed: 200,
      remaining: 300,
      beyondHorizon: 0,
    });
    const amountFor = (id: string) =>
      out.months.map(
        (month) =>
          month.envelopes.find((entry) => entry.id === id)?.amount ?? 0,
      );
    expect(amountFor(renovation.shortcode)).toEqual([75, 75, 75, 75, 0, 0]);
    // $1,200 over 14 months: six in the horizon, the rest beyond it.
    expect(amountFor(longRun.shortcode)).toEqual([
      85.72, 85.72, 85.72, 85.72, 85.72, 85.72,
    ]);
    expect(out.totals.beyondHorizon).toBe(685.68);

    expect(out.unscheduled).toEqual([
      expect.objectContaining({
        id: unscheduled.shortcode,
        remaining: 400,
        endDate: null,
      }),
    ]);
    expect(out.totals.unscheduledTotal).toBe(400);

    // The committed $200 lands once, in December; the envelope already
    // excludes it. The overdue $80 lands now; the far row is past the horizon.
    expect(out.months.map((month) => month.committed)).toEqual([
      80, 0, 200, 0, 0, 0,
    ]);
    expect(out.months[0]?.committedOverdue).toBe(80);
    expect(out.totals.committedBeyondHorizon).toBe(999);

    const withNotStarted = await project6({ includeNotStarted: true });
    expect(withNotStarted.envelopes.map((envelope) => envelope.id)).toContain(
      notStarted.shortcode,
    );
  });

  it("draws an envelope down by net spend, so a refund restores remaining", async () => {
    const refunded = await projectRow("refunded", { costEstimate: 1000 });
    await spend("refunded purchase", 500, "2026-05-10", {
      projectId: refunded.id,
    });
    await spend("refunded credit", -200, "2026-06-10", {
      projectId: refunded.id,
    });
    const out = await project6();
    expect(out.unscheduled).toEqual([
      expect.objectContaining({ id: refunded.shortcode, remaining: 700 }),
    ]);
  });

  it("expands once and monthly scenarios within the horizon and nets them", async () => {
    await fixture();
    const out = await project6({
      scenarios: [
        {
          label: "Synthetic one-off",
          date: "2026-11-03",
          amount: 500,
          direction: "outflow",
          recurrence: "once",
        },
        {
          label: "Synthetic stipend",
          date: "2026-09-01",
          until: "2027-01-15",
          amount: 1000,
          direction: "inflow",
          recurrence: "monthly",
        },
        {
          label: "Synthetic past",
          date: "2026-01-01",
          amount: 700,
          direction: "outflow",
          recurrence: "once",
        },
      ],
    });
    expect(out.months.map((month) => month.scenarioInflow)).toEqual([
      1000, 1000, 1000, 1000, 0, 0,
    ]);
    expect(out.months.map((month) => month.scenarioOutflow)).toEqual([
      0, 500, 0, 0, 0, 0,
    ]);
    // 84.17 baseline + 75 + 85.72 envelopes + 80 overdue committed.
    expect(out.months[0]).toMatchObject({ outflow: 324.89, net: 675.11 });
    expect(out.totals).toMatchObject({
      horizonOutflow: 2099.34,
      horizonInflow: 4000,
      netAfterScenarios: 1900.66,
    });
  });

  it("narrows the baseline to root categories and refuses a non-root code", async () => {
    const { sparse } = await fixture();
    const out = await project6({
      irregular: "separate",
      categoryIds: [sparse.shortcode],
    });
    expect(out.baseline.map((row) => row.key)).toEqual([sparse.shortcode]);
    const child = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic non-root",
      parentId: sparse.id,
    });
    await expect(project6({ categoryIds: [child.shortcode] })).rejects.toThrow(
      /Not a live root Spending Category/u,
    );
  });
});
