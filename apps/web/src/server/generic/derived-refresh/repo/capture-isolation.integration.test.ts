import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { repositoryBeforeCommit } from "~/server/db/repository-access.boundary";
import {
  derivedRefreshCaptureInbox,
  derivedRefreshScope,
  derivedRefreshWork,
  product,
} from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { captureDerivedRefresh, foldDerivedRefreshCaptures } from "./capture";
import { hasUnmaterializedInputs, currentInputRevision } from "./freshness";

const ctx = withTestDb();
let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());

// Background scheduling metadata must not invalidate a financial-style snapshot.
// The second connection replaces the tuple on every attempt; no quiet period or
// retry can make this interleaving safe when capture shares worker-owned rows.
it("commits a snapshot write while the affected root's background progress advances", async () => {
  const subject = await createProductIdentityFixture(
    ctx.db,
    makeProductInput({ name: "Synthetic isolated capture" }),
    ctx.actor,
  );
  await getDb(ctx.db)
    .insert(derivedRefreshWork)
    .values({
      entityKind: "product",
      entityId: subject.entityId,
      inputFingerprint: "synthetic-progress",
    })
    .onConflictDoNothing();
  await expect(
    withTransactionDatabase(
      ctx.db,
      async (tx) => {
        await getDb(tx)
          .select({ notes: product.notes })
          .from(product)
          .where(eq(product.id, subject.entityId));
        await getDb(ctx.db)
          .update(derivedRefreshWork)
          .set({ availableAt: new Date(0) })
          .where(eq(derivedRefreshWork.entityId, subject.entityId));
        await getDb(tx)
          .update(product)
          .set({ notes: "Synthetic committed note" })
          .where(eq(product.id, subject.entityId));
        await captureDerivedRefresh(tx, [
          { entityKind: "product", entityId: subject.entityId },
        ]);
      },
      { isolationLevel: "serializable" },
    ),
  ).resolves.toBeUndefined();
  const [stored] = await getDb(ctx.db)
    .select({ notes: product.notes })
    .from(product)
    .where(eq(product.id, subject.entityId));
  expect(stored?.notes).toBe("Synthetic committed note");
  const pending = await getDb(ctx.db).select().from(derivedRefreshCaptureInbox);
  expect(pending.some((row) => row.entityId === subject.entityId)).toBe(true);
});

// Folding and acknowledgement share one transaction. A crash must retain the
// exact removed endpoints; bookkeeping must not advance the input epoch again.
it("replays rolled-back folding with old/new endpoints and no extra input revision", async () => {
  const create = (name: string) =>
    createProductFixture(ctx.db, makeProductInput({ name }), ctx.actor);
  const root = await create("Synthetic folded root");
  const old = await create("Synthetic old endpoint");
  const next = await create("Synthetic new endpoint");
  await foldDerivedRefreshCaptures(ctx.db);
  await getDb(ctx.db)
    .update(derivedRefreshWork)
    .set({ state: "completed" })
    .where(eq(derivedRefreshWork.entityId, root.entityId));
  await captureDerivedRefresh(ctx.db, [
    {
      entityKind: "product",
      entityId: root.entityId,
      changedFields: ["notes"],
      scopes: [
        { entityKind: "product", entityId: old.entityId },
        { entityKind: "product", entityId: next.entityId },
      ],
    },
  ]);
  const revision = await currentInputRevision(ctx.db);
  await expect(
    withTransactionDatabase(ctx.db, async (tx) => {
      expect(await foldDerivedRefreshCaptures(tx)).toBe(1);
      throw new Error("Synthetic fold interruption");
    }),
  ).rejects.toThrow("Synthetic fold interruption");
  expect(
    await getDb(ctx.db).select().from(derivedRefreshCaptureInbox),
  ).toHaveLength(1);
  expect(await foldDerivedRefreshCaptures(ctx.db)).toBe(1);
  expect(await foldDerivedRefreshCaptures(ctx.db)).toBe(0);
  expect(await currentInputRevision(ctx.db)).toBe(revision);
  const [work] = await getDb(ctx.db)
    .select()
    .from(derivedRefreshWork)
    .where(eq(derivedRefreshWork.entityId, root.entityId));
  expect(work?.changedFields).toEqual({ notes: true });
  if (!work) throw new Error("Synthetic folded work is missing");
  const scopes = await getDb(ctx.db)
    .select()
    .from(derivedRefreshScope)
    .where(eq(derivedRefreshScope.workId, work.id));
  expect(scopes.map((row) => row.entityId).sort()).toEqual(
    [root.entityId, old.entityId, next.entityId].sort(),
  );
});

it("keeps a captured input stale before the background fold and rolls capture back with a failed save", async () => {
  const subject = await createProductIdentityFixture(
    ctx.db,
    makeProductInput({
      name: "Synthetic pending freshness",
      notes: "Synthetic original",
    }),
    ctx.actor,
  );
  await foldDerivedRefreshCaptures(ctx.db);
  await getDb(ctx.db).update(derivedRefreshWork).set({ state: "completed" });
  expect(await hasUnmaterializedInputs(ctx.db, ["product"])).toBe(false);
  const before = queue.tasks.length;
  await expect(
    withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx)
        .update(product)
        .set({ notes: "Synthetic rejected" })
        .where(eq(product.id, subject.entityId));
      await captureDerivedRefresh(tx, [
        { entityKind: "product", entityId: subject.entityId },
      ]);
      await repositoryBeforeCommit(tx, async () => {
        throw new Error("Synthetic save interruption");
      });
    }),
  ).rejects.toThrow("Synthetic save interruption");
  expect(
    await getDb(ctx.db).select().from(derivedRefreshCaptureInbox),
  ).toHaveLength(0);
  expect(queue.tasks).toHaveLength(before);
  const [stored] = await getDb(ctx.db)
    .select({ notes: product.notes })
    .from(product)
    .where(eq(product.id, subject.entityId));
  expect(stored?.notes).toBe("Synthetic original");
  await captureDerivedRefresh(ctx.db, [
    { entityKind: "product", entityId: subject.entityId },
  ]);
  expect(await hasUnmaterializedInputs(ctx.db, ["product"])).toBe(true);
  expect(await hasUnmaterializedInputs(ctx.db, ["expense"])).toBe(false);
  await foldDerivedRefreshCaptures(ctx.db);
  expect(await hasUnmaterializedInputs(ctx.db, ["product"])).toBe(true);
});
