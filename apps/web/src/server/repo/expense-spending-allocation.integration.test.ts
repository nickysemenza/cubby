import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  loadExpenseAnalysisPeriod,
  loadExpenseEntityFacetOptions,
  loadExpensePresenceFacetOptions,
} from "~/server/repo/expense/analyze";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  expenseAllocatedCostSql,
  loadExpenseJointAllocations,
  loadExpenseProjectAllocations,
} from "./expense-project-allocation";
import { loadExpenseSpendingAllocations } from "./expense-spending-allocation";

const ctx = withTestDb("mcp");
const line = (
  name: string,
  cost: number | null,
  lineKind: ExpenseLineKind,
  links: Pick<
    typeof expense.$inferInsert,
    "purchaseId" | "projectId" | "spendingCategoryId"
  >,
) =>
  insertWithShortcode(ctx.db, "expense", {
    name,
    cost,
    lineKind,
    date: "2026-09-20",
    costType: "materials",
    trade: "other",
    future: false,
    ...links,
  });
const fixture = async () => {
  const projects = await Promise.all(
    ["One", "Two"].map((part) =>
      insertWithShortcode(ctx.db, "project", {
        name: `Synthetic ${part} project`,
      }),
    ),
  );
  const categories = await Promise.all(
    ["One", "Two"].map((part) =>
      insertWithShortcode(ctx.db, "spendingCategory", {
        name: `Synthetic ${part} category`,
      }),
    ),
  );
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic allocation vendor",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-20",
    defaultProjectId: projects[0]!.id,
  });
  return { projects, categories, purchase, vendor };
};

describe("joint expense spending allocation", () => {
  it("rounds once by stable principal IDs and groups a Project/category grid without fanout", async () => {
    const { projects, categories, purchase } = await fixture();
    const principal = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        line(`Synthetic item ${index}`, 1, "principal", {
          purchaseId: purchase.id,
          projectId: projects[Math.floor(index / 2)]!.id,
          spendingCategoryId: categories[index % 2]!.id,
        }),
      ),
    );
    const fee = await line("Synthetic one-cent fee", 0.01, "fee", {
      purchaseId: purchase.id,
    });
    const rows = await loadExpenseJointAllocations(ctx.db, [fee.id]);
    expect(rows).toHaveLength(4);
    const winner = [...principal].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    expect(
      rows
        .filter((row) => row.attributedCents === 1n)
        .map((row) => row.principalExpenseId),
    ).toEqual([winner.id]);
    expect(
      rows.reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n),
    ).toBe(1n);
    const projectRows = await loadExpenseProjectAllocations(ctx.db, [fee.id]);
    for (const project of projects) {
      expect(
        projectRows.find((row) => row.projectId === project.id)
          ?.attributedCents,
      ).toBe(
        rows
          .filter((row) => row.projectId === project.id)
          .reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n),
      );
    }
    const scoped = await unwrapDb(ctx.db).execute<{ amount: number }>(
      sql`SELECT ${expenseAllocatedCostSql(sql`${fee.id}::uuid`, {
        projectIds: [winner.projectId!],
        spendingCategoryIds: [winner.spendingCategoryId!],
      })} AS amount`,
    );
    expect(scoped.rows[0]?.amount).toBe(0.01);
    const where = eq(expense.purchaseId, purchase.id);
    const grid = await loadExpenseAnalysisPeriod(
      ctx.db,
      where,
      where,
      "project",
      "spendingCategory",
    );
    expect(grid.cells).toHaveLength(4);
    expect(
      new Set(grid.cells.map((cell) => `${cell.rowKey}:${cell.columnKey}`))
        .size,
    ).toBe(4);
    expect(grid.cells.reduce((sum, cell) => sum + cell.net, 0)).toBeCloseTo(
      4.01,
    );
    expect(grid.scope.net).toBeCloseTo(4.01);
    await unwrapDb(ctx.db)
      .update(expense)
      .set({
        projectId: projects[1]!.id,
        spendingCategoryId: categories[1]!.id,
      })
      .where(eq(expense.id, winner.id));
    const changed = await loadExpenseJointAllocations(ctx.db, [fee.id]);
    expect(
      changed
        .filter((row) => row.attributedCents === 1n)
        .map((row) => row.principalExpenseId),
    ).toEqual([winner.id]);
    expect(
      changed.find((row) => row.principalExpenseId === winner.id),
    ).toMatchObject({
      projectId: projects[1]!.id,
      spendingCategoryId: categories[1]!.id,
    });
  });

  it("keeps unknown refund adjustments uncategorized while ordinary discounts conserve signed cents", async () => {
    const { projects, categories, purchase, vendor } = await fixture();
    await line("Synthetic retained item", 10, "principal", {
      purchaseId: purchase.id,
      projectId: projects[0]!.id,
      spendingCategoryId: categories[0]!.id,
    });
    await line("Synthetic refund item", -5, "principal", {
      purchaseId: purchase.id,
      projectId: projects[1]!.id,
      spendingCategoryId: categories[1]!.id,
    });
    const tax = await line("Synthetic refund tax", -0.03, "tax", {
      purchaseId: purchase.id,
    });
    const discount = await line(
      "Synthetic basket discount",
      -0.01,
      "discount",
      { purchaseId: purchase.id },
    );
    const map = await loadExpenseSpendingAllocations(ctx.db, [
      tax.id,
      discount.id,
    ]);
    expect(map.get(tax.id)).toEqual([
      expect.objectContaining({
        spendingCategoryId: null,
        amount: -0.03,
        basis: "positive",
        incomplete: true,
      }),
    ]);
    expect(map.get(discount.id)).toEqual([
      expect.objectContaining({
        spendingCategoryId: categories[0]!.id,
        amount: -0.01,
        incomplete: false,
      }),
    ]);
    const refundPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    for (const [index, cost] of [-1, -2].entries())
      await line(`Synthetic refund-only item ${index}`, cost, "principal", {
        purchaseId: refundPurchase.id,
        projectId: projects[index]!.id,
        spendingCategoryId: categories[index]!.id,
      });
    const refundFee = await line("Synthetic refund-only fee", -0.05, "fee", {
      purchaseId: refundPurchase.id,
    });
    const refundRows = (
      await loadExpenseSpendingAllocations(ctx.db, [refundFee.id])
    ).get(refundFee.id)!;
    expect(refundRows.map((row) => row.amount).sort()).toEqual([-0.02, -0.03]);
    expect(
      refundRows.every((row) => row.basis === "refund" && !row.incomplete),
    ).toBe(true);
  });

  it("retains unknown, zero, unpriced and standalone shares without inventing a denominator", async () => {
    const { projects, categories, purchase } = await fixture();
    await line("Synthetic zero item", 0, "principal", {
      purchaseId: purchase.id,
      spendingCategoryId: categories[0]!.id,
    });
    const unpriced = await line("Synthetic unpriced item", null, "principal", {
      purchaseId: purchase.id,
    });
    const fee = await line("Synthetic unweighted fee", 0.07, "fee", {
      purchaseId: purchase.id,
    });
    const standalone = await line(
      "Synthetic standalone credit",
      -0.02,
      "principal",
      { projectId: projects[1]!.id },
    );
    const rows = await loadExpenseJointAllocations(ctx.db, [
      fee.id,
      standalone.id,
      unpriced.id,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expenseId: fee.id,
          principalExpenseId: null,
          sourceCents: 7n,
          attributedCents: 7n,
          projectId: projects[0]!.id,
          spendingCategoryId: null,
          basis: "default",
          incomplete: true,
        }),
        expect.objectContaining({
          expenseId: standalone.id,
          principalExpenseId: standalone.id,
          attributedCents: -2n,
          projectId: projects[1]!.id,
          spendingCategoryId: null,
        }),
        expect.objectContaining({
          expenseId: unpriced.id,
          principalExpenseId: unpriced.id,
          attributedCents: null,
          incomplete: true,
        }),
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n),
    ).toBe(5n);
    const map = await loadExpenseSpendingAllocations(ctx.db, [
      fee.id,
      standalone.id,
      unpriced.id,
    ]);
    expect(map.get(unpriced.id)).toEqual([
      expect.objectContaining({ amount: null, incomplete: true }),
    ]);
    expect(await loadExpenseJointAllocations(ctx.db, [])).toEqual([]);
    expect((await loadExpenseSpendingAllocations(ctx.db, [])).size).toBe(0);
  });
  it("previews principal category changes in adjustment allocations without writes", async () => {
    const { projects, categories, purchase } = await fixture();
    const principal = await line("Synthetic preview item", 1, "principal", {
      purchaseId: purchase.id,
      projectId: projects[0]!.id,
      spendingCategoryId: categories[0]!.id,
    });
    const fee = await line("Synthetic preview fee", 0.01, "fee", {
      purchaseId: purchase.id,
    });
    const draft = {
      expenses: [{ id: principal.id, spendingCategoryId: categories[1]!.id }],
    };
    const rows = await loadExpenseJointAllocations(ctx.db, [fee.id], draft);
    expect(rows).toEqual([
      expect.objectContaining({
        spendingCategoryId: categories[1]!.id,
        attributedCents: 1n,
      }),
    ]);
    const stored = await loadExpenseSpendingAllocations(ctx.db, [fee.id]);
    expect(stored.get(fee.id)).toEqual([
      expect.objectContaining({
        spendingCategoryId: categories[0]!.id,
        amount: 0.01,
      }),
    ]);
    const unchanged = await unwrapDb(ctx.db)
      .select({ categoryId: expense.spendingCategoryId })
      .from(expense)
      .where(eq(expense.id, principal.id));
    expect(unchanged[0]?.categoryId).toBe(categories[0]!.id);
  });

  it("counts Project facets from the selected category shares of a shared adjustment", async () => {
    const { projects, categories, purchase } = await fixture();
    for (const index of [0, 1])
      await line(`Synthetic facet item ${index}`, 1, "principal", {
        purchaseId: purchase.id,
        projectId: projects[index]!.id,
        spendingCategoryId: categories[index]!.id,
      });
    const fee = await line("Synthetic facet fee", 0.02, "fee", {
      purchaseId: purchase.id,
    });
    const facets = await loadExpenseEntityFacetOptions(
      ctx.db,
      eq(expense.id, fee.id),
      "project",
      {
        spendingCategoryIds: [categories[0]!.id],
      },
    );
    expect(facets).toEqual([
      { value: projects[0]!.shortcode, label: projects[0]!.name, count: 1 },
    ]);
  });
  it("counts Project presence only among matching category shares", async () => {
    const { projects, categories, vendor } = await fixture();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
    });
    for (const index of [0, 1])
      await line(`Synthetic presence item ${index}`, 1, "principal", {
        purchaseId: purchase.id,
        projectId: index === 0 ? projects[0]!.id : null,
        spendingCategoryId: categories[index]!.id,
      });
    const fee = await line("Synthetic presence fee", 0.02, "fee", {
      purchaseId: purchase.id,
    });
    const presence = await loadExpensePresenceFacetOptions(
      ctx.db,
      eq(expense.id, fee.id),
      "project",
      {
        spendingCategoryIds: [categories[0]!.id],
      },
    );
    expect(presence).toEqual([
      { value: "__any__", label: null, count: 1 },
      { value: "__none__", label: null, count: 0 },
    ]);
  });
  it("keeps principal classification completeness independent of Project and missing-price uncertainty", async () => {
    const { categories, purchase } = await fixture();
    const unpriced = await line(
      "Synthetic categorized unpriced item",
      null,
      "principal",
      {
        purchaseId: purchase.id,
        spendingCategoryId: categories[0]!.id,
      },
    );
    const initial = await loadExpenseSpendingAllocations(ctx.db, [unpriced.id]);
    expect(initial.get(unpriced.id)).toEqual([
      expect.objectContaining({
        spendingCategoryId: categories[0]!.id,
        amount: null,
        incomplete: false,
      }),
    ]);
    expect(
      (await loadExpenseProjectAllocations(ctx.db, [unpriced.id]))[0]
        ?.incomplete,
    ).toBe(true);
    await line("Synthetic priced sibling", 1, "principal", {
      purchaseId: purchase.id,
      spendingCategoryId: categories[0]!.id,
    });
    const automatic = await line(
      "Synthetic automatic uncertain fee",
      0.01,
      "fee",
      { purchaseId: purchase.id },
    );
    const shared = await loadExpenseSpendingAllocations(ctx.db, [automatic.id]);
    expect(shared.get(automatic.id)).toEqual([
      expect.objectContaining({
        spendingCategoryId: categories[0]!.id,
        amount: 0.01,
        incomplete: true,
      }),
    ]);
  });
});
