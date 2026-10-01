import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { householdContributionLedger, projectContribution } from "./reports";

describe("household contribution reports", () => {
  const ctx = withTestDb("mcp");

  it("includes planned future Expenses in project cost but excludes them from household as-of positions", async () => {
    const { output: project } = await createRepoEntity(ctx, "project", {
      name: "Future contribution fixture",
    });
    const { output: futureExpense } = await createRepoEntity(ctx, "expense", {
      name: "Planned fixture expense",
      cost: 125,
      date: "2026-08-01",
      costType: "materials",
      trade: "other",
      future: true,
      projectId: project.id,
    });

    const [household, projectReport] = await Promise.all([
      householdContributionLedger(ctx.db, { asOf: "2026-08-23" }),
      projectContribution(ctx.db, {
        projectId: project.id,
        includeSubprojects: true,
      }),
    ]);

    expect(household.checks.expenseTotal).toBe(0);
    expect(household.gaps).toEqual([]);
    expect(projectReport.wholeGroupCost).toBe(125);
    // The beneficiary is still `missing_*` because this fixture DB has no
    // household LedgerParty, so the assumed-household arm cannot fire. That is
    // load-bearing, not incidental — with a household party present this would
    // aggregate instead.
    expect(projectReport.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_beneficiaries",
          targetIds: [futureExpense.id],
        }),
      ]),
    );
    // A future Expense has no funder because it is not due yet, which is a
    // status rather than a reconciliation gap. It reports as one aggregated
    // entry carrying a count, and never as `missing_funders`.
    expect(projectReport.gaps.map((gap) => gap.code)).not.toContain(
      "missing_funders",
    );
    expect(
      projectReport.gaps.find((gap) => gap.code === "funder_not_yet_paid"),
    ).toMatchObject({ amount: 125, count: 1, targetIds: [] });
  });
});
