import { entityRecommendationsOut } from "@cubby/schemas/entity-recommendations";
import { costTypeSchema } from "@cubby/schemas/expense-fields";
import { parseShortcodeFor, type ProjectId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";
import { snapshotJson } from "~/server/domains/connection/repo/connection-evidence";
import {
  deleteExpenses,
  getExpenseByShortcode,
  updateExpense,
} from "~/server/domains/expense/repo/crud";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { createProduct } from "~/server/domains/product/repo/crud";
import { projectContentDatesExcluding } from "~/server/domains/project/repo/analytics";
import { getEntityRecommendations } from "~/server/domains/recommendation/service/entity-recommendations.service";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson } from "~/server/lib/canonical-json";
import { makeProductInput } from "~/server/testing/repo.fixtures";

import {
  expenseProjectRecommendationContext,
  expenseProjectRecommendationContexts,
  prepareExpenseProjectRecommendationContexts,
} from "./project-recommendations";

describe("expense project recommendation evidence", () => {
  const ctx = withTestDb();

  it("removes the reviewed expense from derived ancestor windows and keeps manual overrides", async () => {
    const parent = await createRepoEntity(ctx, "project", {
      name: "Derived parent",
    });
    const child = await createRepoEntity(ctx, "project", {
      name: "Assigned child",
      parentProjectId: parent.output.id,
    });
    const override = await createRepoEntity(ctx, "project", {
      name: "Explicit window",
      dates: { start: "2024-06-01", end: "2024-06-30" },
    });
    const source = await createRepoEntity(ctx, "expense", {
      name: "Review this charge",
      projectId: child.output.id,
      date: "2024-06-15",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const result = entityRecommendationsOut.parse(
      await getEntityRecommendations(ctx.db, {
        entityKind: "expense",
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
    const current = await createRepoEntity(ctx, "project", { name: "Current" });
    const preferred = await createRepoEntity(ctx, "project", {
      name: "Zulu exact product",
      dates: { start: "2024-01-01", end: "2024-12-31" },
    });
    const other = await createRepoEntity(ctx, "project", {
      name: "Alpha trade",
      dates: { start: "2024-06-01", end: "2024-06-30" },
    });
    const first = await createRepoEntity(ctx, "expense", {
      name: "Same product history",
      projectId: preferred.output.id,
      productId: product.id,
      date: "2024-06-01",
      trade: "electrical",
      costType: "materials",
      cost: 10,
    });
    await createRepoEntity(ctx, "expense", {
      name: "Same trade history",
      projectId: other.output.id,
      date: "2024-06-02",
      trade: "electrical",
      costType: "materials",
      cost: 30,
    });
    const deleted = await createRepoEntity(ctx, "expense", {
      name: "Deleted evidence",
      projectId: other.output.id,
      productId: product.id,
      date: "2024-06-02",
      trade: "electrical",
      costType: "materials",
      cost: 40,
    });
    await deleteExpenses(ctx.db, [deleted.output.id], ctx.actor);
    const source = await createRepoEntity(ctx, "expense", {
      name: "Review switch",
      projectId: current.output.id,
      productId: product.id,
      date: "2024-06-15",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const result = await getEntityRecommendations(ctx.db, {
      entityKind: "expense",
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
      entityKind: "expense",
      entityId: source.output.id,
    });
    expect(after.basisKey).not.toBe(result.basisKey);
  });

  it("offers derived task windows to unassigned expenses", async () => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Task window",
    });
    await createRepoEntity(ctx, "task", {
      name: "Dated work",
      projectId: project.output.id,
      due: { start: "2024-06-01", end: "2024-06-30" },
      trade: "electrical",
    });
    const dated = await createRepoEntity(ctx, "expense", {
      name: "Unassigned",
      date: "2024-06-15",
      trade: "electrical",
      costType: "materials",
      cost: 20,
    });
    const result = await getEntityRecommendations(ctx.db, {
      entityKind: "expense",
      entityId: dated.output.id,
    });
    expect(result.groups[0]).toMatchObject({
      currentTarget: null,
      proposals: [{ target: { id: project.output.id } }],
    });
  });

  // Freshness checks read many candidates at once. Excluding each candidate
  // from one shared allocation must match excluding it in its own read.
  it("batches project windows per excluded expense like one exclusion at a time", async () => {
    const parent = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic parent",
    });
    const [child, sibling] = await Promise.all([
      insertWithShortcode(ctx.db, "project", {
        name: "Synthetic child",
        parentProjectId: parent.id,
      }),
      insertWithShortcode(ctx.db, "project", { name: "Synthetic sibling" }),
    ]);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic window supplier",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2024-08-01",
    });
    const line = (values: Partial<typeof expense.$inferInsert>) =>
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic dated line",
        cost: 5,
        lineKind: "principal",
        costType: "materials",
        trade: "electrical",
        future: false,
        ...values,
      });
    const lines = [
      await line({ projectId: child.id, date: "2024-06-15" }),
      await line({ projectId: child.id, date: "2024-07-01" }),
      await line({ projectId: sibling.id, date: "2024-05-01" }),
      await line({
        projectId: sibling.id,
        date: "2024-08-01",
        purchaseId: order.id,
      }),
      await line({
        lineKind: "tax",
        trade: null,
        costType: "services",
        date: "2024-08-02",
        purchaseId: order.id,
      }),
    ];
    const undated = await line({ trade: "plumbing", cost: null });
    const ids = [...lines.map((row) => row.id), undated.id];
    // Duplicates and another spelling of a uuid resolve to the same exclusion.
    const batched = await projectContentDatesExcluding(ctx.db, [
      ...ids,
      ids[0]!,
      ids[1]!.toUpperCase() as (typeof ids)[number],
    ]);
    expect(batched.get(ids[1]!.toUpperCase() as (typeof ids)[number])).toEqual(
      batched.get(ids[1]!),
    );
    for (const id of ids) {
      const alone = await unwrapDb(ctx.db).execute<{
        projectId: ProjectId;
        contentStart: string | null;
        contentEnd: string | null;
      }>(sql`SELECT allocation."projectId",
          min(e."date") AS "contentStart", max(e."date") AS "contentEnd"
        FROM (${expenseDerivedReadSql("projects")}) allocation
        JOIN "Expense" e ON e."id" = allocation."expenseId"
        WHERE allocation."projectId" IS NOT NULL AND e."id" <> ${id}
        GROUP BY allocation."projectId"`);
      expect(batched.get(id)).toEqual(
        new Map(
          alone.rows.map((row) => [
            row.projectId,
            { contentStart: row.contentStart, contentEnd: row.contentEnd },
          ]),
        ),
      );
    }
    expect(batched.get(ids[0]!)?.get(child.id)).toEqual({
      contentStart: "2024-07-01",
      contentEnd: "2024-07-01",
    });

    // Item lines get a context; adjustments and unknown codes do not.
    const contexts = await expenseProjectRecommendationContexts(ctx.db, [
      ...lines.map((row) => row.shortcode),
      parseShortcodeFor("expense", "EXP-ZZZZZ"),
    ]);
    expect([...contexts.values()].map((context) => context !== null)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  // A basis is fingerprinted: rewriting a column the evidence does not read
  // moves the line's tuple, and must not reorder or otherwise change it.
  // Contexts read together must also equal contexts read alone.
  it("keeps recommendation evidence stable and identical in batches", async () => {
    const [kitchen, garage] = await Promise.all([
      insertWithShortcode(ctx.db, "project", { name: "Synthetic kitchen" }),
      insertWithShortcode(ctx.db, "project", { name: "Synthetic garage" }),
    ]);
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic breaker",
      brandId: await findOrCreateVendor(ctx.db, "Synthetic maker"),
    });
    const line = (values: Partial<typeof expense.$inferInsert>) =>
      insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic wiring",
        cost: 5,
        date: "2024-06-01",
        lineKind: "principal",
        costType: "materials",
        trade: "electrical",
        future: false,
        ...values,
      });
    const history = [
      await line({ projectId: kitchen.id }),
      await line({ projectId: garage.id }),
      await line({
        projectId: kitchen.id,
        trade: "plumbing",
        productId: product.id,
      }),
      await line({ projectId: garage.id, trade: "plumbing" }),
    ];
    const sources = [
      await line({ projectId: kitchen.id, productId: product.id }),
      await line({ projectId: garage.id, trade: "plumbing" }),
    ];
    const codes = sources.map((row) => row.shortcode);
    const read = async () =>
      new Map(
        [...(await expenseProjectRecommendationContexts(ctx.db, codes))].map(
          ([code, context]) => [code, canonicalJson(snapshotJson(context))],
        ),
      );
    const before = await read();
    // Bounded freshness batches must not reread shared ledger/project inputs
    // or retain every expanded context merely to avoid those repeated reads.
    const prepared = await prepareExpenseProjectRecommendationContexts(
      ctx.db,
      codes,
    );
    const chunked = await countTestDbQueries(
      async () =>
        new Map(
          codes
            .slice()
            .reverse()
            .map((code) => [
              code,
              canonicalJson(snapshotJson(prepared([code]).get(code))),
            ]),
        ),
    );
    expect(chunked.result).toEqual(before);
    expect(chunked.queryCount).toBe(0);
    for (const code of codes)
      expect(before.get(code)).toBe(
        canonicalJson(
          snapshotJson(await expenseProjectRecommendationContext(ctx.db, code)),
        ),
      );
    await unwrapDb(ctx.db).execute(
      // An indexed column, so the update cannot stay HOT and the row moves.
      sql`UPDATE "Expense" SET "costType" = ${costTypeSchema.enum.tools} WHERE id = ${history[0]!.id}`,
    );
    expect(await read()).toEqual(before);
  });
});
