import { taskCreateInput } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import {
  countTestDbQueries,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import { getDb } from "~/server/db/helpers";
import { task, job } from "~/server/db/schema";
import { createTask } from "~/server/domains/task/repo/crud";
import { executeEntity } from "~/server/entity-kernel";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocuments,
} from "~/server/generic/search/repo/search-document";
import {
  drainDerivedRefreshFrontier,
  captureBackgroundQueue,
} from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// A set-based projection write can have constant query count while touching
// every dependent. Observe stored dependent text before any background drain.
describe("bounded entity writes", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

  it("refreshes adjustment project text when a principal Expense's Project is renamed", async () => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic Studio",
      defaultTrade: "other",
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic adjustment vendor",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      orderId: "SYNTHETIC-ADJUSTMENT",
      defaultProjectId: null,
    });
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic principal",
      lineKind: "principal",
      trade: "other",
      cost: 100,
      purchaseId: purchase.output.id,
      projectId: project.output.id,
    });
    const tax = await createRepoEntity(ctx, "expense", {
      name: "Synthetic tax",
      lineKind: "tax",
      trade: "other",
      cost: 10,
      purchaseId: purchase.output.id,
      projectId: null,
    });
    const drain = () => drainDerivedRefreshFrontier(ctx.db);
    await drain();
    expect(
      (await getSearchDocumentEmbeddingText(ctx.db, "expense", tax.entityId))
        ?.embeddingText,
    ).toContain("Synthetic Studio");
    await executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
      action: "update",
      entity: "project",
      id: project.output.id,
      data: { name: "Synthetic Workshop" },
    });
    await drain();
    const text = (
      await getSearchDocumentEmbeddingText(ctx.db, "expense", tax.entityId)
    )?.embeddingText;
    expect(text).toContain("Synthetic Workshop");
    expect(text).not.toContain("Synthetic Studio");
  });

  it("commits a Product rename without rewriting dependent projections", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic canvas cover" }),
      ctx.actor,
    );
    const dependent = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Maintain synthetic cover",
          subjectProductId: product.id,
          trade: "other",
        },
      }),
      ctx.actor,
    );
    await refreshSearchDocuments(ctx.db, [
      { entityKind: "product", entityId: product.entityId },
      { entityKind: "task", entityId: dependent.entityId },
    ]);
    const before = await getSearchDocumentEmbeddingText(
      ctx.db,
      "task",
      dependent.entityId,
    );
    expect(before?.embeddingText).toContain("Synthetic canvas cover");

    const measured = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "product",
        id: product.id,
        data: { name: "Synthetic fitted cover" },
      }),
    );

    expect(measured.result.item.id).toBe(product.id);
    expect(Object.keys(measured.result.item).sort()).toEqual(["id", "name"]);
    expect(measured.queryCount).toBeLessThanOrEqual(80);
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "task", dependent.entityId),
    ).toEqual(before);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(
      (await getSearchDocumentEmbeddingText(ctx.db, "task", dependent.entityId))
        ?.embeddingText,
    ).toContain("Synthetic fitted cover");
  });

  it("does not scan or reject unrelated invalid descendants on a name-only Task edit", async () => {
    const make = (name: string) =>
      createTask(
        ctx.db,
        mock(taskCreateInput, {
          overrides: { name, trade: "other" },
        }),
        ctx.actor,
      );
    const target = await make("Synthetic target task");
    const unrelated = await make("Synthetic unrelated task");
    await getDb(ctx.db)
      .update(task)
      .set({ trade: null })
      .where(eq(task.id, unrelated.entityId));
    const result = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "task",
        id: target.output.id,
        data: { name: "Synthetic renamed task" },
      }),
    );
    expect(result.result.item.id).toBe(target.output.id);
    expect(
      result.statements.filter(
        (statement) =>
          statement.includes("UNION ALL") && statement.includes("'expense'"),
      ),
    ).toEqual([]);
  });

  it("does not inspect allocation or reference collections on a FinancialTransaction note edit", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic note-only account",
      identity: { kind: "credit_card", network: "visa" },
      cardNumbers: [],
      sourceAliases: [],
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 25,
      postedDate: "2026-01-01",
      sourceRefs: [],
    });
    const measured = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "financialTransaction",
        id: transaction.output.id,
        data: { notes: "Synthetic bounded note" },
      }),
    );
    expect(measured.result.item).toEqual({
      id: transaction.output.id,
      notes: "Synthetic bounded note",
    });
    expect(
      measured.tables.filter((table) =>
        [
          "FinancialTransactionAllocation",
          "EntityExternalId",
          "Purchase",
        ].includes(table),
      ),
    ).toEqual([]);
  });

  it("coalesces repeated edits into one durable search Job", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic coalesced product" }),
      ctx.actor,
    );
    const context = buildKernelContext(ctx.db, testUserId(TEST_USER_ID));
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: product.id,
      data: { name: "Synthetic second name" },
    });
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: product.id,
      data: { name: "Synthetic third name" },
    });
    const work = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "refresh:search"));
    expect(work).toHaveLength(1);
  });

  it("patches a stored collection without hydrating dependent detail", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collection budget",
        tags: ["Synthetic-A"],
      }),
      ctx.actor,
    );
    const measured = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "product",
        id: subject.id,
        data: { tags: [{ op: "add", key: "Synthetic-B" }] },
      }),
    );
    expect(measured.result.item).toEqual({ id: subject.id });
    expect(
      measured.statements.filter((statement) =>
        statement.includes('"Expense"'),
      ),
    ).toEqual([]);
    expect(measured.queryCount).toBeLessThanOrEqual(80);
  });
});
