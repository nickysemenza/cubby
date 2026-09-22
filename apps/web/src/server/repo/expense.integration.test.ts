import type {
  ExpenseId,
  PurchaseId,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  type ExpenseCreateInput,
  type ExpenseOut,
  expenseCreateInput,
  expenseUpdateData,
  projectCreateInput,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Database } from "~/server/db";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityMutationCommand } from "~/server/entity-kernel/contracts";
import { getAuditLog } from "~/server/repo/audit-log";
import {
  createExpense,
  deleteExpenses,
  expenseAnalytics,
  expenseList,
  expenseMonthlySummary,
  getExpenseByShortcode,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "~/server/repo/expense";
import { createProduct } from "~/server/repo/product";
import { createProject } from "~/server/repo/project";
import { getPurchaseExpenses, purchaseList } from "~/server/repo/purchase";
import {
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";
import { vendorOptions } from "~/server/repo/vendor";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  expenseAnalyticsWorkflow,
  expenseAnalyzeWorkflow,
  expenseChargeContextWorkflow,
  expenseChartDataWorkflow,
  expenseFacetCountsWorkflow,
  expenseTradeAffinityWorkflow,
} from "~/server/workflows/expense.server";

const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

const auditChangeSchema = z
  .record(
    z.string(),
    z.object({ from: z.string().nullish(), to: z.string().nullish() }),
  )
  .nullish();

const auditChangeFor = <TChanges>(changes: TChanges, field: string) => {
  const parsed = auditChangeSchema.safeParse(changes);
  return parsed.success ? parsed.data?.[field] : undefined;
};

const expenseBulkUpdateData = expenseUpdateData
  .pick({ projectId: true, trade: true, costType: true })
  .strict();
const expenseBulkUpdateCommand = z.object({
  action: z.literal("bulkUpdate"),
  entity: z.literal("expense"),
  ids: z.array(z.string().min(1)),
  data: expenseBulkUpdateData,
});
type ExpenseBulkUpdateAttempt = Partial<ExpenseCreateInput>;
type ExpenseCreateSeed = z.input<typeof expenseCreateInput>;

const createExpenseWorkflowCaller = (db: Database) => ({
  chartData: (input: Parameters<typeof expenseChartDataWorkflow>[1]) =>
    expenseChartDataWorkflow(db, input),
  analytics: (input: Parameters<typeof expenseAnalyticsWorkflow>[1]) =>
    expenseAnalyticsWorkflow(db, input),
  chargeContext: (input: Parameters<typeof expenseChargeContextWorkflow>[1]) =>
    expenseChargeContextWorkflow(db, input),
  tradeAffinity: () => expenseTradeAffinityWorkflow(db),
});

const purchaseIdOf = (expense: ExpenseOut): PurchaseShortcode => {
  if (!expense.purchaseId) {
    throw new Error(`expected a resolved charge on "${expense.name}"`);
  }
  return expense.purchaseId;
};

describe("expense workflows — analyzer orchestration", () => {
  const ctx = withTestDb();

  it("returns analysis periods and mixed facet kinds through declared workflows", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Workflow analysis project" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2026-05-10",
        name: "Workflow analysis material",
        trade: "plumbing",
        costType: "materials",
        cost: 40,
        projectId: project.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2026-05-11",
        name: "Workflow analysis service",
        trade: "plumbing",
        costType: "services",
        cost: 60,
      }),
      ctx.actor,
    );

    const filters = { dateFrom: "2026-05-01", dateTo: "2026-05-31" };
    const analysis = await expenseAnalyzeWorkflow(ctx.db, {
      filters,
      rowDimension: "trade",
      comparison: "previousPeriod",
    });
    expect(analysis).toMatchObject({
      status: "ready",
      comparison: {
        mode: "previousPeriod",
        previousRange: { dateFrom: "2026-03-31", dateTo: "2026-04-30" },
      },
    });

    const facets = await expenseFacetCountsWorkflow(ctx.db, {
      filters,
      facetIds: ["trade", "project", "orderIdPresence"],
    });
    expect(facets.facets.map((facet) => facet.id)).toEqual([
      "trade",
      "project",
      "orderIdPresence",
    ]);
    expect(facets.facets[0]?.options).toContainEqual({
      value: "plumbing",
      label: null,
      count: 2,
    });
    expect(facets.facets[1]?.options).toContainEqual({
      value: project.id,
      label: project.name,
      count: 1,
    });
  });
});

/** Folded purchases are tombstoned but must remain resolvable for assertions. */
const purchaseUuid = async (
  db: Database,
  code: PurchaseShortcode,
): Promise<PurchaseId> => {
  const resolved = await resolveShortcode(db, code);
  if (!resolved) throw new Error(`purchase not found: ${code}`);
  return parseEntityId("purchase", resolved.id);
};

describe("expense repository — CRUD", () => {
  const ctx = withTestDb();

  it("returns charge siblings through the workflow and returns null for an unlinked expense", async () => {
    const { output: unlinked } = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "Unlinked expense" }),
      ctx.actor,
    );
    expect(await expenseChargeContextWorkflow(ctx.db, unlinked.id)).toBeNull();
    const { output: first } = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "First charge line",
        vendor: "Charge context supplies",
        orderId: "CHARGE-CONTEXT",
        cost: 12,
      }),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Second charge line",
        purchaseId: purchaseIdOf(first),
        cost: 7,
      }),
      ctx.actor,
    );
    const result = await expenseChargeContextWorkflow(ctx.db, first.id);
    expect(result?.purchase.id).toBe(first.purchaseId);
    expect(
      result?.siblings.map((row) => ({ id: row.id, cost: row.cost })),
    ).toEqual([{ id: second.id, cost: 7 }]);
    expect(await expenseChargeContextWorkflow(ctx.db, unlinked.id)).toBeNull();
  });

  it("creates, reads (with projectName join), updates (incl. clearing date/projectId), and deletes", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "expense crud project" }),
      ctx.actor,
    );

    const { output: created } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "test faucet",
        projectId: project.id,
        cost: 42.5,
        date: "2026-01-15",
        url: "https://example.com/faucet",
        notes: "brushed nickel",
        future: false,
      }),
      ctx.actor,
    );

    const read = await getExpenseByShortcode(ctx.db, created.id);
    expect(read).toMatchObject({
      name: "test faucet",
      cost: 42.5,
      date: "2026-01-15",
      costType: "materials",
      trade: "plumbing",
      url: "https://example.com/faucet",
      notes: "brushed nickel",
      future: false,
      projectId: project.id,
      projectName: project.name,
    });

    const { output: updated } = await updateExpense(
      ctx.db,
      created.id,
      { name: "updated faucet", cost: 55, projectId: null },
      ctx.actor,
    );
    expect(updated.name).toBe("updated faucet");
    expect(updated.cost).toBe(55);
    expect(updated.date).toBe("2026-01-15");
    expect(updated.projectId).toBeNull();
    expect(updated.projectName).toBeNull();

    await deleteExpenses(ctx.db, [created.id], ctx.actor);

    expect(await getExpenseByShortcode(ctx.db, created.id)).toBeNull();

    const { data } = await expenseList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(data.map((p) => p.id)).not.toContain(created.id);
  });

  it("infers line roles once, honors explicit roles, audits changes, and protects product links", async () => {
    const { output: inferredTax, entityId: inferredTaxId } =
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "Sales tax",
            cost: 26.81,
            vendor: "Line role fixture vendor",
            orderId: "LINE-ROLE-1",
          }),
        ),
        ctx.actor,
      );
    expect(inferredTax.lineKind).toBe("tax");

    const explicitPrincipal = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: "Sales tax", lineKind: "principal" }),
        ),
        ctx.actor,
      ),
    );
    expect(explicitPrincipal.lineKind).toBe("principal");

    const renamed = await unwrap(
      updateExpense(
        ctx.db,
        explicitPrincipal.id,
        { name: "Shipping" },
        ctx.actor,
      ),
    );
    expect(renamed.lineKind).toBe("principal");

    const productRow = await createProduct(
      ctx.db,
      makeProductInput({ name: "line role product" }),
      ctx.actor,
    );
    const productExpense = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: "Tax", productId: productRow.id }),
        ),
        ctx.actor,
      ),
    );
    expect(productExpense.lineKind).toBe("principal");

    await expect(
      updateExpense(ctx.db, productExpense.id, { lineKind: "tax" }, ctx.actor),
    ).rejects.toMatchObject({
      reason: "CONSTRAINT_VIOLATION",
    });
    expect(
      (await getExpenseByShortcode(ctx.db, productExpense.id))?.productId,
    ).toBe(productRow.id);

    await expect(
      updateExpense(
        ctx.db,
        inferredTax.id,
        { productId: productRow.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "CONSTRAINT_VIOLATION",
    });
    expect(
      (await getExpenseByShortcode(ctx.db, inferredTax.id))?.productId,
    ).toBeNull();

    const changedKind = await unwrap(
      updateExpense(ctx.db, inferredTax.id, { lineKind: "fee" }, ctx.actor),
    );
    expect(changedKind.lineKind).toBe("fee");
    const audit = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: inferredTaxId,
      limit: 20,
    });
    expect(
      audit.entries.some((entry) => {
        const lineKindChange = auditChangeFor(entry.changes, "lineKind");
        return (
          entry.action === "update" &&
          lineKindChange?.from === "tax" &&
          lineKindChange?.to === "fee"
        );
      }),
    ).toBe(true);

    const discount = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "Order discount",
            cost: -60,
            vendor: "Line role fixture vendor",
            orderId: "LINE-ROLE-1",
          }),
        ),
        ctx.actor,
      ),
    );
    const taxRefund = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "Tax refund",
            cost: -8.5,
            lineKind: "tax",
            vendor: "Line role fixture vendor",
            orderId: "LINE-ROLE-1",
          }),
        ),
        ctx.actor,
      ),
    );
    expect(discount.lineKind).toBe("discount");
    expect(taxRefund).toMatchObject({ lineKind: "tax", cost: -8.5 });
  });

  // Regression guard: reclassifying a principal line as an adjustment used to
  // be a client-side companion write (`projectId: null` sent alongside from
  // the expense list only); the server owns the rule now so an embedded
  // relation table's inline edit reaches the same outcome.
  it("drops the project when a principal line becomes an adjustment", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "line role reclassify project" }),
      ctx.actor,
    );
    const principal = await unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "Order handling",
            cost: 12,
            lineKind: "principal",
            projectId: project.id,
            vendor: "Line role fixture vendor",
            orderId: "LINE-ROLE-2",
          }),
        ),
        ctx.actor,
      ),
    );
    expect(principal.projectId).toBe(project.id);

    const reclassified = await unwrap(
      updateExpense(ctx.db, principal.id, { lineKind: "fee" }, ctx.actor),
    );
    expect(reclassified).toMatchObject({ lineKind: "fee", projectId: null });
  });
});

describe("expense workflow", () => {
  const ctx = withTestDb();

  describe("projectPresenceFilter", () => {
    const seedProjectMix = async () => {
      const [{ output: projA }, { output: projB }] = await Promise.all([
        createProject(
          ctx.db,
          projectCreateInput.parse({ name: "assigned home" }),
          ctx.actor,
        ),
        createProject(
          ctx.db,
          projectCreateInput.parse({ name: "other home" }),
          ctx.actor,
        ),
      ]);
      for (const [name, projectId] of [
        ["has a project", projA.id],
        ["other project", projB.id],
        ["needs a project", undefined],
      ] as const) {
        const input: ExpenseCreateSeed = {
          date: "2024-01-15",
          trade: "drywall",
          costType: "tools",
          name,
        };
        if (projectId !== undefined) input.projectId = projectId;
        await createExpense(ctx.db, expenseCreateInput.parse(input), ctx.actor);
      }
      return { projA, projB };
    };

    // buildExpenseWhereClause backs BOTH the ledger list and the analytics
    // aggregates; this pins that they still agree through the new OR branch.
    it("keeps ledger totals and analytics totals in agreement", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db);
      const { projA } = await seedProjectMix();
      const filters = {
        projectId: [projA.id],
        projectPresenceFilter: "none" as const,
      };

      const [listed, analytics] = await Promise.all([
        expenseList(ctx.db, filters, [], { pageIndex: 0, pageSize: 500 }),
        caller.analytics(filters),
      ]);

      expect(analytics.summary.count).toBe(listed.data.length);
      expect(analytics.summary.net).toBeCloseTo(
        listed.data.reduce((sum, p) => sum + (p.cost ?? 0), 0),
        2,
      );
    });

    // CUBBY-11R: the relational list leg threw `invalid reference to
    // FROM-clause entry for table "Expense"` under a `trade` filter, because
    // `buildExpenseWhereClause` applied it as a raw-aliased predicate that
    // only the unaliased analytics leg could resolve. Pins that the list and
    // analytics legs agree again now that both run through `tradeCondition`.
    it("keeps the relational list and analytics in agreement under a trade filter", async () => {
      const caller = createExpenseWorkflowCaller(ctx.db);
      await seedProjectMix();
      const filters = { trade: "drywall" as const };

      const [listed, analytics] = await Promise.all([
        expenseList(ctx.db, filters, [], { pageIndex: 0, pageSize: 500 }),
        caller.analytics(filters),
      ]);

      expect(listed.data.length).toBe(3);
      expect(listed.count).toBe(3);
      expect(analytics.summary.count).toBe(3);
    });
  });
});

describe("expense kernel — bulkUpdate", () => {
  const ctx = withTestDb();
  const kernelContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const bulkUpdate = async (ids: string[], data: ExpenseBulkUpdateAttempt) => {
    const command = expenseBulkUpdateCommand.parse({
      action: "bulkUpdate",
      entity: "expense",
      ids,
      data,
    });
    const result = await executeEntity(
      kernelContext(),
      command satisfies EntityMutationCommand,
    );
    if (result.action !== "bulkUpdate") throw new Error("unreachable");
    return result;
  };

  it("applies trade and cost type in one patch", async () => {
    const { output: e } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "kernel two fields",
      }),
      ctx.actor,
    );

    expect(
      (await bulkUpdate([e.id], { trade: "drywall", costType: "services" }))
        .updatedReferences,
    ).toEqual([{ entity: "expense", id: e.id }]);
    const reread = await getExpenseByShortcode(ctx.db, e.id);
    expect(reread?.trade).toBe("drywall");
    expect(reread?.costType).toBe("services");
  });

  it("rejects a partially missing selection before changing any expense", async () => {
    const { output: expense } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "atomic expense patch",
      }),
      ctx.actor,
    );

    await expect(
      bulkUpdate([expense.id, testShortcode("expense", "EXP-ZZZZ")], {
        trade: "drywall",
      }),
    ).rejects.toMatchObject({ reason: "EXPENSE_NOT_FOUND" });
    expect((await getExpenseByShortcode(ctx.db, expense.id))?.trade).toBe(
      "other",
    );
  });
});

describe("expense repository — bulk trade / cost-type writes", () => {
  const ctx = withTestDb();

  const line = (name: string, overrides: Partial<ExpenseCreateInput> = {}) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(makeExpenseInput({ name, ...overrides })),
      ctx.actor,
    );

  const updateEntries = async (id: ExpenseId) =>
    (
      await getAuditLog(ctx.db, {
        entityType: "expense",
        entityId: id,
        limit: 50,
      })
    ).entries.filter((e) => e.action === "update");

  const changeOf = <TEntry extends { changes: TChanges }, TChanges>(
    entry: TEntry | undefined,
    field: "trade" | "costType",
  ) => (entry ? auditChangeFor(entry.changes, field) : undefined);

  it("setExpensesTrade writes the trade over the listed ids only, and audits just the rows that changed", async () => {
    const { output: a, entityId: aId } = await line("bulk trade a", {
      trade: "other",
    });
    const { output: b } = await line("bulk trade b", { trade: "other" });
    // Already carries the target value: it must be written (harmlessly) but NOT
    // audited — `computeChanges` returns null, so the `if (changes)` arm skips it.
    const { output: already, entityId: alreadyId } = await line(
      "bulk trade already electrical",
      { trade: "electrical" },
    );
    const { output: untouched } = await line("bulk trade bystander", {
      trade: "plumbing",
    });

    const updated = await setExpensesTrade(
      ctx.db,
      { ids: [a.id, b.id, already.id], trade: "electrical" },
      ctx.actor,
    );

    expect(updated.map((row) => row.trade)).toEqual([
      "electrical",
      "electrical",
      "electrical",
    ]);
    expect((await getExpenseByShortcode(ctx.db, untouched.id))?.trade).toBe(
      "plumbing",
    );

    expect(changeOf((await updateEntries(aId))[0], "trade")).toEqual({
      from: "other",
      to: "electrical",
    });
    expect(await updateEntries(alreadyId)).toHaveLength(0);
  });

  it("setExpensesCostType writes the cost type and audits only the changed rows", async () => {
    const { output: a, entityId: aId } = await line("bulk costType a", {
      costType: "materials",
    });
    const { output: already, entityId: alreadyId } = await line(
      "bulk costType already tools",
      { costType: "tools" },
    );

    const updated = await setExpensesCostType(
      ctx.db,
      { ids: [a.id, already.id], costType: "tools" },
      ctx.actor,
    );
    expect(updated.map((row) => row.costType)).toEqual(["tools", "tools"]);

    expect(changeOf((await updateEntries(aId))[0], "costType")).toEqual({
      from: "materials",
      to: "tools",
    });
    expect(await updateEntries(alreadyId)).toHaveLength(0);
  });
});

describe("expense repository — expenseAnalytics", () => {
  const ctx = withTestDb();

  it("uses attributed adjustment shares throughout project-filtered analytics", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "scoped analytics project a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "scoped analytics project b" }),
      ctx.actor,
    );
    const purchaseIdentity = {
      vendor: "Scoped analytics vendor",
      orderId: "SCOPED-ANALYTICS-1",
    };
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        ...purchaseIdentity,
        date: "2026-06-10",
        name: "scoped analytics principal a",
        trade: "plumbing",
        costType: "materials",
        cost: 60,
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        ...purchaseIdentity,
        date: "2026-06-10",
        name: "scoped analytics principal b",
        trade: "plumbing",
        costType: "materials",
        cost: 40,
        projectId: projectB.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        ...purchaseIdentity,
        date: "2026-06-10",
        lineKind: "tax",
        name: "scoped analytics tax",
        trade: null,
        costType: "services",
        cost: 10,
      }),
      ctx.actor,
    );

    const filters = {
      search: "scoped analytics",
      projectId: projectA.id,
    };
    const result = await expenseAnalytics(ctx.db, filters);
    expect(result.summary).toMatchObject({ net: 66, count: 2 });
    expect(result.adjustments).toMatchObject({ net: 6, count: 1 });
    expect(result.monthly).toEqual([
      expect.objectContaining({ month: "2026-06", net: 66, count: 2 }),
    ]);
    expect(result.byProject).toEqual([
      expect.objectContaining({
        projectId: projectA.id,
        net: 66,
        count: 2,
      }),
    ]);

    const analysis = await expenseAnalyzeWorkflow(ctx.db, {
      filters,
      rowDimension: "project",
      comparison: "none",
    });
    expect(analysis).toMatchObject({
      status: "ready",
      totals: {
        scope: { current: { net: 66, count: 2 } },
        grid: { current: { net: 66, count: 2 } },
      },
    });
  });

  it("aggregates match manual arithmetic, omits empty categories, and stays consistent with expenseList under the same filter", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "analytics project b" }),
      ctx.actor,
    );

    const { output: p1 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "plumbing",
        costType: "materials",
        name: "analytics p1 actual",
        projectId: projectA.id,
        vendor: "Analytics allocation vendor",
        orderId: "ANALYTICS-1",
        cost: 100,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p2 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2026-01-20",
        trade: "plumbing",
        costType: "materials",
        name: "analytics p2 committed",
        projectId: projectA.id,
        vendor: "Analytics allocation vendor",
        orderId: "ANALYTICS-1",
        cost: 50,
        future: true,
      }),
      ctx.actor,
    );
    const { output: p3 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "materials",
        name: "analytics p3 credit",
        cost: -20,
        date: "2026-01-15",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p4 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "electrical",
        costType: "services",
        name: "analytics p4 actual",
        projectId: projectB.id,
        cost: 30,
        date: "2026-02-01",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p5 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "services",
        lineKind: "tax",
        name: "analytics p5 tax",
        vendor: "Analytics allocation vendor",
        orderId: "ANALYTICS-1",
        cost: 23,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );
    const { output: p6 } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "tools",
        lineKind: "discount",
        name: "analytics p6 discount",
        vendor: "Analytics allocation vendor",
        orderId: "ANALYTICS-1",
        cost: -5,
        date: "2026-01-10",
        future: false,
      }),
      ctx.actor,
    );

    const filters = { search: "analytics p" };
    const result = await expenseAnalytics(ctx.db, filters);
    expect(await expenseMonthlySummary(ctx.db, filters)).toEqual(
      result.monthly,
    );

    expect(result.summary).toEqual({
      actual: 153,
      committed: 50,
      credits: 25,
      net: 178,
      count: 6,
      actualCount: 5,
      plannedCount: 1, // p2
    });
    expect(result.adjustments).toEqual({
      actual: 23,
      committed: 0,
      credits: 5,
      net: 18,
      count: 2,
    });

    // Dimensional analytics classify principal purchases only. The adjustment
    // rows deliberately carry different historical costType/trade values to
    // prove those values do not leak into the category matrices.
    expect(result.byCostType).toEqual(
      expect.arrayContaining([
        {
          costType: "materials",
          actual: 100,
          committed: 50,
          credits: 20,
          net: 130,
          count: 3,
        },
        {
          costType: "services",
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );
    expect(result.byCostType).toHaveLength(2);

    expect(result.byTrade).toEqual(
      expect.arrayContaining([
        {
          trade: "plumbing",
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          trade: "electrical",
          actual: 30,
          committed: 0,
          credits: 20,
          net: 10,
          count: 2,
        },
      ]),
    );
    expect(result.byTrade).toHaveLength(2);

    expect(result.tradeCostMatrix).toHaveLength(3);
    expect(result.tradeCostMatrix).toEqual(
      expect.arrayContaining([
        {
          trade: "plumbing",
          costType: "materials",
          actual: 100,
          committed: 50,
          credits: 0,
          net: 150,
          count: 2,
        },
        {
          trade: "electrical",
          costType: "materials",
          actual: 0,
          committed: 0,
          credits: 20,
          net: -20,
          count: 1,
        },
        {
          trade: "electrical",
          costType: "services",
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );

    expect(result.monthly).toEqual([
      {
        month: "2026-01",
        actual: 123,
        committed: 50,
        credits: 25,
        net: 148,
        count: 5,
      },
      {
        month: "2026-02",
        actual: 30,
        committed: 0,
        credits: 0,
        net: 30,
        count: 1,
      },
    ]);

    expect(result.cumulative).toEqual([
      { month: "2026-01", cumulativeNet: 148 },
      { month: "2026-02", cumulativeNet: 178 },
    ]);

    expect(result.byProject).toEqual(
      expect.arrayContaining([
        {
          projectId: projectA.id,
          projectName: projectA.name,
          actual: 123,
          committed: 50,
          credits: 5,
          net: 168,
          count: 4,
        },
        {
          projectId: projectB.id,
          projectName: projectB.name,
          actual: 30,
          committed: 0,
          credits: 0,
          net: 30,
          count: 1,
        },
      ]),
    );
    expect(result.byProject).toHaveLength(2);

    // Analytics totals must agree with the visible ledger under the same filter.
    const { data: listedRows } = await expenseList(ctx.db, filters, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(listedRows.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id, p3.id, p4.id, p5.id, p6.id].sort(),
    );
    const summedCost = listedRows.reduce((sum, p) => sum + (p.cost ?? 0), 0);
    expect(summedCost).toBe(result.summary.net);
  });
});

// Money and ownership have separate authorities; negative lines record exits.

describe("expense repository — charge grouping", () => {
  const ctx = withTestDb();

  const chargeLine = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) =>
    expenseCreateInput.parse({
      date: "2024-01-15",
      trade: "other",
      costType: "materials",
      name,
      cost: 10,
      vendor,
      orderId,
    });

  it("files two lines of one order onto ONE charge, where they see each other", async () => {
    const orderId = "111-charge-0000001";
    const { output: first } = await createExpense(
      ctx.db,
      chargeLine("order line one", "Amazon", orderId),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      chargeLine("order line two", "Amazon", orderId),
      ctx.actor,
    );
    // Same order id under a DIFFERENT vendor is a different charge — an order id
    // is only unique within a vendor, which is exactly what the partial-unique
    // `(vendorId, orderId)` index encodes.
    const { output: collision } = await createExpense(
      ctx.db,
      chargeLine("same id, other retailer", "Home Depot", orderId),
      ctx.actor,
    );
    const { output: otherOrder } = await createExpense(
      ctx.db,
      chargeLine("different order", "Amazon", "111-charge-0000002"),
      ctx.actor,
    );

    expect(purchaseIdOf(first)).toBe(purchaseIdOf(second));
    expect(purchaseIdOf(collision)).not.toBe(purchaseIdOf(first));
    expect(purchaseIdOf(otherOrder)).not.toBe(purchaseIdOf(first));

    const lines = await getPurchaseExpenses(
      ctx.db,
      await purchaseUuid(ctx.db, purchaseIdOf(first)),
    );
    expect(lines.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(lines.map((p) => p.id)).not.toContain(collision.id);
    expect(lines.map((p) => p.id)).not.toContain(otherOrder.id);
  });
});

describe("expense repository — charge resolution on update", () => {
  const ctx = withTestDb();
  const page = { pageIndex: 0, pageSize: 100 };

  const line = (
    name: string,
    vendor: string | null,
    orderId: string | null = null,
  ) => makeExpenseInput({ name, cost: 10, vendor, orderId });

  // REGRESSION GUARD. This was a live bug: `resolveCharge` read only
  // `data.vendor` and returned "no change" whenever it was omitted, ignoring
  // `current.vendorName` sitting in the same argument — so an `{ orderId }`-only
  // update was silently dropped.
  //
  // It is not a hypothetical input shape, it is the ONLY shape the UI sends: both
  // Order # inline editors save `data: { orderId }` and nothing else
  // (app/expenses/expenselist.tsx and app/projects/shared.tsx), so typing an
  // order number into the ledger's Order # cell did nothing on every
  // vendor-bearing row — breaking the central purchase-import workflow.
  //
  // The test below this one pins the constraint the fix must not break: a
  // genuinely vendorless row still drops the order id.

  /**
   * ATOMICITY GATE — fails on the pre-`withTransactionOn` code.
   *
   * `resolveCharge` used to run in its OWN transaction and commit, and only then
   * did the factory's column write run in a second one. So when the write failed
   * — `updateLiveAndReturn` throws when there is no live row, which is exactly
   * what a concurrent soft-delete produces — the vendor and charge it had just
   * minted survived with nothing pointing at them, and nothing sweeps up empty
   * charges. Same invariant `createExpense` already documents ("a vendor or
   * charge created here must not outlive a failed expense write"), which the
   * update path silently didn't hold.
   *
   * The delete-then-update ordering here is the deterministic form of the race:
   * the window it models is "soft-deleted after `resolveCharge` read the row",
   * and the observable outcome is identical.
   */
  it("rolls back a resolved vendor AND charge when the row was concurrently soft-deleted", async () => {
    const { output: doomed, entityId: doomedId } = await createExpense(
      ctx.db,
      line("about to be deleted", null),
      ctx.actor,
    );
    const chargesBefore = (await purchaseList(ctx.db, {}, [], page)).count;
    const vendorsBefore = (await vendorOptions(ctx.db)).length;

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    await expect(
      updateExpense(
        ctx.db,
        doomed.id,
        { vendor: "Ghost Supply Co", orderId: "GSC-rollback-1" },
        ctx.actor,
      ),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();

    expect((await vendorOptions(ctx.db)).map((v) => v.name)).not.toContain(
      "Ghost Supply Co",
    );
    expect((await vendorOptions(ctx.db)).length).toBe(vendorsBefore);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(
      chargesBefore,
    );

    // And no audit entry for a write that never landed. `getAuditLog`'s
    // `entityId` matches the internal uuid, not the shortcode.
    const audit = await getAuditLog(ctx.db, {
      entityType: "expense",
      entityId: doomedId,
      limit: 20,
    });
    expect(audit.entries.filter((e) => e.action === "update")).toEqual([]);
  });
});
