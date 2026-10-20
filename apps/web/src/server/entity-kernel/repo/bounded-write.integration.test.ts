import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { taskCreateInput } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import {
  countTestDbQueries,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import { getDb } from "~/server/db/helpers";
import {
  task,
  derivedRefreshWork,
  derivedRefreshScope,
  productConversionCoverage,
} from "~/server/db/schema";
import { writeProductConversionCoverageProjection } from "~/server/domains/product/repo/conversion-coverage";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { createTask } from "~/server/domains/task/repo/crud";
import { executeEntity } from "~/server/entity-kernel";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocuments,
} from "~/server/generic/search/repo/search-document";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
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
    const drain = async () => {
      for (let page = 0; page < 500; page++) {
        const result = await processDerivedRefreshPage(ctx.db);
        expect(result.errors).toEqual([]);
        if (result.done) return;
      }
      throw new Error("Synthetic adjustment refresh did not terminate");
    };
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

  it("does not traverse from a Product rename through sibling purchase lines to another Product", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic changed purchase product" }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unrelated purchase product" }),
      ctx.actor,
    );
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic shared purchase vendor",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      orderId: "SYNTHETIC-SHARED-PURCHASE",
      vendorId: vendor.output.id,
    });
    for (const product of [first, second])
      await createRepoEntity(ctx, "expense", {
        name: "Synthetic shared purchase line",
        lineKind: "principal",
        trade: "other",
        cost: 10,
        productId: product.id,
        purchaseId: purchase.output.id,
      });
    for (let page = 0; page < 500; page++)
      if ((await processDerivedRefreshPage(ctx.db)).done) break;
    await executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
      action: "update",
      entity: "product",
      id: first.id,
      data: { name: "Synthetic renamed purchase product" },
    });
    const [work] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, first.entityId));
    if (!work) throw new Error("Synthetic changed Product work missing");
    for (let page = 0; page < 500; page++)
      if (
        (
          await processDerivedRefreshPage(ctx.db, undefined, {
            frontierOnly: true,
          })
        ).done
      )
        break;
    const sibling = await getDb(ctx.db)
      .select()
      .from(derivedRefreshScope)
      .where(
        and(
          eq(derivedRefreshScope.workId, work.id),
          eq(derivedRefreshScope.entityId, second.entityId),
        ),
      );
    expect(sibling).toEqual([]);
  }, 30_000);

  it("defers kit conversion invalidation when one component price changes", async () => {
    const component = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic kit component", price: 4 }),
      ctx.actor,
    );
    const inserted = await getDb(ctx.db).execute(sql`WITH parents AS (
      INSERT INTO "Product" (shortcode,name,manufacturer,"categoryId")
      SELECT 'PRD-SYN-KIT-' || n, 'Synthetic kit ' || n, 'Synthetic maker', p."categoryId"
      FROM "Product" p CROSS JOIN generate_series(1,1000) n WHERE p.id=${component.entityId}::uuid RETURNING id
    ), links AS (
      INSERT INTO "EntityLink" (kind,"fromKind","fromEntityId","toKind","toEntityId",quantity)
      SELECT 'productComponent',${entitySchema.enum.product},id,${entitySchema.enum.product},${component.entityId}::uuid,1 FROM parents
    ) SELECT id FROM parents`);
    const parents = z
      .array(z.object({ id: z.uuid() }))
      .parse(inserted.rows)
      .map((row) => parseEntityId("product", row.id));
    await writeProductConversionCoverageProjection(
      ctx.db,
      parents.map((productId) => ({
        productId,
        coverageTier: "synthetic",
        coveredKinds: [],
        applicableKinds: [],
        islandCount: 0,
        status: "ready",
      })),
    );
    const measured = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "product",
        id: component.id,
        data: { price: 8 },
      }),
    );
    expect(measured.tables).not.toContain("EntityLink");
    expect(measured.tables).not.toContain("ProductConversionCoverage");
    let invalidated = false;
    for (let page = 0; page < 100; page++) {
      await processDerivedRefreshPage(ctx.db);
      const [stale] = await getDb(ctx.db)
        .select({ id: productConversionCoverage.productId })
        .from(productConversionCoverage)
        .where(
          and(
            inArray(productConversionCoverage.productId, parents),
            eq(productConversionCoverage.status, "stale"),
          ),
        )
        .limit(1);
      if (stale) {
        invalidated = true;
        break;
      }
    }
    expect(invalidated).toBe(true);
  });

  it("commits a Product rename without rewriting dependent projections", async () => {
    const product = await createProductFixture(
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
    let complete = false;
    for (let page = 0; page < 500; page++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      if (result.done) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
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
      identity: { kind: "credit_card", issuer: null, network: "visa" },
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

  it("coalesces repeated edits into one root wave", async () => {
    const product = await createProductFixture(
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
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, product.entityId));
    expect(work).toHaveLength(1);
  });

  it("patches a stored collection without hydrating dependent detail", async () => {
    const subject = await createProductFixture(
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
