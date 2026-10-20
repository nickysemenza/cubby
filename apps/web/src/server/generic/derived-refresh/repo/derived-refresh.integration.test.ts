import { testUserId } from "@cubby/schemas/testing";
import { and, eq } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  derivedRefreshCursor,
  derivedRefreshScope,
  derivedRefreshWork,
  product,
  searchDocument,
} from "~/server/db/schema";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { executeEntity } from "~/server/entity-kernel";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { captureDerivedRefresh } from "./capture";
import { reconcileDerivedRefreshPage } from "./reconcile";

async function drain(db: Parameters<typeof processDerivedRefreshPage>[0]) {
  for (let page = 0; page < 2_000; page++) {
    const result = await processDerivedRefreshPage(db);
    expect(result.errors).toEqual([]);
    if (result.done) return;
  }
  throw new Error("Synthetic refresh did not converge within its page budget");
}

// Lost wakeups, SQL-only edits and transport retries cannot require another save.
describe("durable derived refresh", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  const fixture = () =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic repair subject" }),
      ctx.actor,
    );

  it("repairs documents missed while embeddings were unconfigured without another edit", async () => {
    const subject = await fixture();
    await drain(ctx.db);
    await getDb(ctx.db)
      .insert(derivedRefreshCursor)
      .values({
        key: "derived-refresh",
        cursor: {
          phase: "embeddings",
          table: 0,
          after: null,
          startedAt: new Date().toISOString(),
        },
      })
      .onConflictDoUpdate({
        target: derivedRefreshCursor.key,
        set: {
          cursor: {
            phase: "embeddings",
            table: 0,
            after: null,
            startedAt: new Date().toISOString(),
          },
          availableAt: new Date(0),
        },
      });
    await reconcileDerivedRefreshPage(ctx.db, {
      embeddingConfig: getSemanticEmbeddingConfig(),
    });
    const [pending] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, subject.entityId));
    expect(pending).toMatchObject({ state: "pending", publishing: false });
  });

  it("rolls root work and queue publication back with the authoritative write", async () => {
    const subject = await fixture();
    await drain(ctx.db);
    queue.tasks.length = 0;
    const [before] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, subject.entityId));
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await executeEntity(buildKernelContext(tx, testUserId(TEST_USER_ID)), {
          action: "update",
          entity: "product",
          id: subject.id,
          data: { name: "Synthetic rolled back name" },
        });
        throw new Error("Synthetic rollback");
      }),
    ).rejects.toThrow("Synthetic rollback");
    const [after] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, subject.entityId));
    expect(after).toEqual(before);
    expect(queue.tasks).toEqual([]);
  });

  // Metadata locks must follow every business write in the outer transaction.
  it("defers capture until outer commit and discards a rolled-back savepoint", async () => {
    const subject = await fixture();
    await drain(ctx.db);
    const [before] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, subject.entityId));
    await withTransactionDatabase(ctx.db, async (outer) => {
      await captureDerivedRefresh(outer, [
        {
          entityKind: "product",
          entityId: subject.entityId,
          changedFields: ["name"],
        },
      ]);
      await expect(
        withTransactionDatabase(outer, async (inner) => {
          await captureDerivedRefresh(inner, [
            {
              entityKind: "product",
              entityId: subject.entityId,
              changedFields: ["notes"],
            },
          ]);
          throw new Error("Synthetic savepoint rollback");
        }),
      ).rejects.toThrow("Synthetic savepoint rollback");
      const [during] = await getDb(outer)
        .select()
        .from(derivedRefreshWork)
        .where(eq(derivedRefreshWork.entityId, subject.entityId));
      expect(during?.version).toBe(before?.version);
    });
    const [after] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, subject.entityId));
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.changedFields).toEqual({ name: true });
  });

  it("repairs an unmarked SQL edit and a missing projection without a queue message", async () => {
    const subject = await fixture();
    await drain(ctx.db);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic SQL-only repair" })
      .where(eq(product.id, subject.entityId));
    await getDb(ctx.db)
      .delete(searchDocument)
      .where(
        and(
          eq(searchDocument.entityKind, "product"),
          eq(searchDocument.entityId, subject.entityId),
        ),
      );
    queue.tasks.length = 0;
    let complete = false;
    for (let page = 0; page < 2_000; page++) {
      const result = await reconcileDerivedRefreshPage(ctx.db);
      if (result.done) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    await drain(ctx.db);
    const [document] = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(
        and(
          eq(searchDocument.entityKind, "product"),
          eq(searchDocument.entityId, subject.entityId),
        ),
      );
    expect(document?.title).toBe("Synthetic SQL-only repair");
  });

  it("keeps the failure budget when an unchanged repair is requested again", async () => {
    const subject = await fixture();
    await processDerivedRefreshPage(ctx.db);
    const [work] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, subject.entityId));
    if (!work) throw new Error("Synthetic work missing");
    await getDb(ctx.db)
      .update(derivedRefreshScope)
      .set({ phase: "synthetic-invalid-phase", version: work.version })
      .where(eq(derivedRefreshScope.workId, work.id));
    for (let attempt = 0; attempt < 3; attempt++) {
      await getDb(ctx.db)
        .update(derivedRefreshWork)
        .set({ availableAt: new Date(0) })
        .where(eq(derivedRefreshWork.id, work.id));
      expect((await processDerivedRefreshPage(ctx.db)).errors).toHaveLength(1);
    }
    await drain(ctx.db);
    await captureDerivedRefresh(
      ctx.db,
      [{ entityKind: "product", entityId: subject.entityId }],
      { invalidate: false },
    );
    const [failed] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.id, work.id));
    expect(failed).toMatchObject({
      state: "failed",
      attempts: 3,
      version: work.version,
    });
    expect(failed?.lastError).toContain("synthetic-invalid-phase");
  });
});
