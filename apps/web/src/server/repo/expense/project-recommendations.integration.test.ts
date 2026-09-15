import { entityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createExpense,
  deleteExpenses,
  getExpenseByShortcode,
  updateExpense,
} from "~/server/repo/expense";
import { createProduct } from "~/server/repo/product";
import { createProject } from "~/server/repo/project";
import { makeProductInput } from "~/server/repo/repo.fixtures";
import { createTask } from "~/server/repo/task";
import { getEntityRecommendations } from "~/server/services/entity-recommendations.service";

describe("expense project recommendation evidence", () => {
  const ctx = withTestDb();

  it("removes the reviewed expense from derived ancestor windows and keeps manual overrides", async () => {
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Derived parent" }),
      ctx.actor,
    );
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Assigned child",
        parentProjectId: parent.output.id,
      }),
      ctx.actor,
    );
    const override = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Explicit window",
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      }),
      ctx.actor,
    );
    const source = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Review this charge",
        projectId: child.output.id,
        date: "2024-06-15",
        trade: "electrical",
        costType: "materials",
        cost: 20,
      }),
      ctx.actor,
    );
    const result = entityRecommendationsOut.parse(
      await getEntityRecommendations(ctx.db, {
        entityType: "expense",
        entityId: source.output.id,
      }),
    );
    const group = result.groups[0];
    if (group?.kind !== "expense-project")
      throw new Error("Expected expense proposals");
    expect(group.currentTarget?.id).toBe(child.output.id);
    expect(group.proposals.map((proposal) => proposal.target.id)).toEqual([
      override.output.id,
    ]);
    expect(group.proposals[0]?.sameTradeCount).toBe(0);
    expect(group.proposals[0]?.supportingExpenses).toEqual([]);
    expect(
      (await getExpenseByShortcode(ctx.db, source.output.id))?.projectId,
    ).toBe(child.output.id);
  });

  it("ranks exact-product support after trade counts, excludes deleted history, and accepts through the normal update", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Fixture switch" }),
      ctx.actor,
    );
    const current = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Current" }),
      ctx.actor,
    );
    const preferred = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Zulu exact product",
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      }),
      ctx.actor,
    );
    const other = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Alpha trade",
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      }),
      ctx.actor,
    );
    const first = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Same product history",
        projectId: preferred.output.id,
        productId: product.id,
        date: "2024-06-01",
        trade: "electrical",
        costType: "materials",
        cost: 10,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Same trade history",
        projectId: other.output.id,
        date: "2024-06-02",
        trade: "electrical",
        costType: "materials",
        cost: 30,
      }),
      ctx.actor,
    );
    const deleted = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Deleted evidence",
        projectId: other.output.id,
        productId: product.id,
        date: "2024-06-02",
        trade: "electrical",
        costType: "materials",
        cost: 40,
      }),
      ctx.actor,
    );
    await deleteExpenses(ctx.db, [deleted.output.id], ctx.actor);
    const source = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Review switch",
        projectId: current.output.id,
        productId: product.id,
        date: "2024-06-15",
        trade: "electrical",
        costType: "materials",
        cost: 20,
      }),
      ctx.actor,
    );
    const result = await getEntityRecommendations(ctx.db, {
      entityType: "expense",
      entityId: source.output.id,
    });
    const group = result.groups[0];
    if (group?.kind !== "expense-project")
      throw new Error("Expected expense proposals");
    expect(group.proposals.map((proposal) => proposal.target.id)).toEqual([
      preferred.output.id,
      other.output.id,
    ]);
    expect(group.proposals[0]).toMatchObject({
      sameTradeCount: 1,
      exactProductCount: 1,
      supportingExpenses: [{ id: first.output.id, name: first.output.name }],
    });
    expect(group.proposals[1]?.exactProductCount).toBe(0);
    await updateExpense(
      ctx.db,
      source.output.id,
      { projectId: preferred.output.id },
      ctx.actor,
    );
    expect(
      (await getExpenseByShortcode(ctx.db, source.output.id))?.projectId,
    ).toBe(preferred.output.id);
    const after = await getEntityRecommendations(ctx.db, {
      entityType: "expense",
      entityId: source.output.id,
    });
    expect(after.basisKey).not.toBe(result.basisKey);
  });

  it("offers derived task windows to unassigned expenses", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Task window" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Dated work",
        projectId: project.output.id,
        dueDate: "2024-06-01",
        dueEndDate: "2024-06-30",
        trade: "electrical",
      }),
      ctx.actor,
    );
    const dated = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Unassigned",
        date: "2024-06-15",
        trade: "electrical",
        costType: "materials",
        cost: 20,
      }),
      ctx.actor,
    );
    const result = await getEntityRecommendations(ctx.db, {
      entityType: "expense",
      entityId: dated.output.id,
    });
    expect(result.groups[0]).toMatchObject({
      currentTarget: null,
      proposals: [{ target: { id: project.output.id } }],
    });
  });
});
