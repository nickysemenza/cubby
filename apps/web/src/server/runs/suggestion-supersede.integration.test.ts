import { createProjectFromTasksInput } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { type TestDbContext, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { purchase as purchaseTable } from "~/server/db/schema";
import { projectCreateFromTasksWorkflow } from "~/server/operations/project.server";
import { getDb } from "~/server/repo/database-helpers";
import {
  updateExpense,
  updateExpensesInBulk,
} from "~/server/repo/expense/crud";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { listSuggestions } from "~/server/repo/suggestion-review";

import {
  categoryPorts,
  expenseFixture,
  kernelCtx,
  productFixture,
  runCode,
  recordId,
  runSuggestions,
  seedPending,
  startSuggestionSweep,
  suggestionStatus,
} from "./suggestion-sweep.fixtures";

/** Seeds a pending Suggestion, performs one write, returns the Suggestion id. */
type WriteCase = {
  write: string;
  expected: "superseded" | "pending";
  act: (ctx: TestDbContext) => Promise<string>;
};

const rawProductCategoryWrite =
  (nextCategory: "food" | "tools") => async (ctx: TestDbContext) => {
    const product = await productFixture(ctx, "Synthetic imported product", {
      categoryId: taxonomyId("tools"),
    });
    const productRecordId = await recordId(ctx.db, product.id, "product");
    const { id } = await seedPending(ctx, {
      entity: "product",
      recordId: productRecordId,
      field: "categoryId",
      currentValue: taxonomyShortcode("tools"),
      suggestedValue: taxonomyShortcode("food"),
      kind: "correction",
    });
    // Imports write entity columns without the repository layer.
    await getDb(ctx.db).execute(sql`
      UPDATE "Product"
      SET "categoryId" = ${taxonomyId(nextCategory)}
      WHERE "id" = ${productRecordId}
    `);
    return id;
  };

const writeCases: WriteCase[] = [
  {
    write: "a raw import write that changes the column",
    expected: "superseded",
    act: rawProductCategoryWrite("food"),
  },
  {
    write: "a raw write that leaves the column unchanged",
    expected: "pending",
    act: rawProductCategoryWrite("tools"),
  },
  {
    write: "a Task project assignment through the repository",
    expected: "superseded",
    act: async (ctx) => {
      const task = await createRepoEntity(ctx, "task", {
        trade: "other",
        name: "Synthetic task assignment",
      });
      const { id } = await seedPending(ctx, {
        entity: "task",
        recordId: await recordId(ctx.db, task.output.id, "task"),
        field: "projectId",
        currentValue: null,
        suggestedValue: testShortcode("project", "suggested-task-project"),
        kind: "addition",
      });
      await projectCreateFromTasksWorkflow(
        ctx.db,
        createProjectFromTasksInput.parse({
          taskIds: [task.output.id],
          project: { name: "Synthetic task project" },
        }),
        ctx.actor,
      );
      return id;
    },
  },
  {
    write: "a repository bulk Expense patch",
    expected: "superseded",
    act: async (ctx) => {
      const expense = await expenseFixture(
        ctx.db,
        "Synthetic bulk suggestion expense",
      );
      const { id } = await seedPending(ctx, {
        entity: "expense",
        recordId: await recordId(ctx.db, expense.shortcode, "expense"),
        field: "projectId",
        currentValue: null,
        suggestedValue: testShortcode("project", "suggested-expense-project"),
        kind: "addition",
      });
      const project = await createRepoEntity(ctx, "project", {
        name: "Synthetic bulk assignment project",
      });
      await updateExpensesInBulk(
        ctx.db,
        [expense.shortcode],
        { projectId: project.output.id },
        ctx.actor,
      );
      return id;
    },
  },
];

// Regression modes: every write path that changes a suggested column
// supersedes its pending Suggestions, including writes that bypass the
// repository and columns derived through a backing Purchase; an unchanged
// column leaves them pending.
describe("Suggestion supersede", () => {
  const ctx = withTestDb();

  it.each(writeCases)(
    "marks a pending Suggestion $expected after $write",
    async ({ act, expected }) => {
      const id = await act(ctx);
      expect(await suggestionStatus(ctx.db, id)).toBe(expected);
    },
  );

  it("supersedes derived Expense vendor Suggestions when either backing Purchase changes", async () => {
    const vendorA = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic vendor A",
    });
    const vendorB = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic vendor B",
    });
    const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
    const purchases = await Promise.all(
      dates.map((date) =>
        insertWithShortcode(ctx.db, "purchase", { vendorId: vendorA.id, date }),
      ),
    );
    const expenses = await Promise.all(
      purchases.map((purchase, index) =>
        expenseFixture(ctx.db, `Synthetic vendor expense ${index}`, {
          date: dates[index],
          purchaseId: purchase.id,
        }),
      ),
    );
    const assessmentIds = [];
    for (const expense of expenses) {
      const { id } = await seedPending(ctx, {
        entity: "expense",
        recordId: await recordId(ctx.db, expense.shortcode, "expense"),
        field: "vendor",
        currentValue: "Synthetic vendor A",
        suggestedValue: "Synthetic vendor C",
        kind: "correction",
      });
      assessmentIds.push(id);
    }
    // A: the Expense vendor edit rewrites its Purchase.
    await updateExpense(
      ctx.db,
      expenses[0]!.shortcode,
      { vendor: "Synthetic vendor B" },
      ctx.actor,
    );
    // B: a direct Purchase vendor change; C: a Purchase change that leaves
    // the derived vendor alone.
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ vendorId: vendorB.id })
      .where(eq(purchaseTable.id, purchases[1]!.id));
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ date: "2026-09-04" })
      .where(eq(purchaseTable.id, purchases[2]!.id));
    expect(
      await Promise.all(
        assessmentIds.map((id) => suggestionStatus(ctx.db, id)),
      ),
    ).toEqual(["superseded", "superseded", "pending"]);
  });

  it("supersedes an earlier pending suggestion when a newer sweep evaluates the same field", async () => {
    const product = await productFixture(ctx, "Synthetic repeated sweep item", {
      categoryId: taxonomyId("tools"),
    });
    const sweep = () =>
      startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: [product.id] },
        },
        { context: kernelCtx(ctx), ...categoryPorts() },
      );
    const firstRun = await sweep();
    const [first] = await listSuggestions(ctx.db, {
      runId: await runCode(ctx.db, firstRun.id),
      minConfidence: 0,
    });
    if (!first) throw new Error("Synthetic first Suggestion is missing");
    // The review queue names the record by its public shortcode.
    expect(first.recordId).toBe(product.id);
    const secondRun = await sweep();
    expect(await suggestionStatus(ctx.db, first.id)).toBe("superseded");
    expect(await runSuggestions(ctx.db, secondRun.id)).toEqual([
      expect.objectContaining({ status: "pending", kind: "correction" }),
    ]);
  });
});
