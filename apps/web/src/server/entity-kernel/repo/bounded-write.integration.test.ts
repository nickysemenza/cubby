import { taskCreateInput } from "@cubby/schemas/entities/task";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import { getDb } from "~/server/db/helpers";
import { task } from "~/server/db/schema";
import { createTask } from "~/server/domains/task/repo/crud";
import { executeEntity } from "~/server/entity-kernel";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocuments,
} from "~/server/generic/search/repo/search-document";
import { derivedMarkTickets } from "~/server/testing/background-queue";
import {
  drainDerivedRefreshFrontier,
  captureBackgroundQueue,
} from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// Observe stored dependent text before any background drain.
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

    const renamed = await executeEntity(
      buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
      {
        action: "update",
        entity: "product",
        id: product.id,
        data: { name: "Synthetic fitted cover" },
      },
    );

    expect(renamed.item.id).toBe(product.id);
    expect(Object.keys(renamed.item).sort()).toEqual(["id", "name"]);
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "task", dependent.entityId),
    ).toEqual(before);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(
      (await getSearchDocumentEmbeddingText(ctx.db, "task", dependent.entityId))
        ?.embeddingText,
    ).toContain("Synthetic fitted cover");
  });

  it("does not reject unrelated invalid descendants on a name-only Task edit", async () => {
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
    const result = await executeEntity(
      buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
      {
        action: "update",
        entity: "task",
        id: target.output.id,
        data: { name: "Synthetic renamed task" },
      },
    );
    expect(result.item.id).toBe(target.output.id);
  });

  it("returns only the edited note on a FinancialTransaction note edit", async () => {
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
    const updated = await executeEntity(
      buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
      {
        action: "update",
        entity: "financialTransaction",
        id: transaction.output.id,
        data: { notes: "Synthetic bounded note" },
      },
    );
    expect(updated.item).toEqual({
      id: transaction.output.id,
      notes: "Synthetic bounded note",
    });
  });

  it("coalesces repeated edits into one search mark", async () => {
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
    expect(
      await derivedMarkTickets(
        ctx.db,
        "product.searchDocument",
        product.entityId,
      ),
    ).toHaveLength(1);
  });
});
