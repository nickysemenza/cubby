import { testUserId } from "@cubby/schemas/testing";
import { eq, sql } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  derivedRefreshScope,
  derivedRefreshWork,
  product,
  searchDocument,
} from "~/server/db/schema";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { executeEntity } from "~/server/entity-kernel";
import * as search from "~/server/generic/search/repo/search-document";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { captureDerivedRefresh } from "./capture";
import { currentInputRevision } from "./freshness";

// Each barrier controls a real PostgreSQL interleaving; no timing assertions.
describe("derived refresh publication ownership", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
    vi.restoreAllMocks();
  });
  const fixture = () =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic ownership subject" }),
      ctx.actor,
    );

  it("rolls back prepared output when a newer source edit replaces ownership", async () => {
    const subject = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prepare = search.prepareSearchDocuments;
    vi.spyOn(search, "prepareSearchDocuments").mockImplementationOnce(
      async (...args) => {
        const result = await prepare(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    const old = processDerivedRefreshPage(ctx.db);
    await entered.promise;
    try {
      await executeEntity(
        buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
        {
          action: "update",
          entity: "product",
          id: subject.id,
          data: { name: "Synthetic newer subject" },
        },
      );
    } finally {
      release.resolve();
    }
    expect(await old).toMatchObject({ processed: 0, errors: [] });
    expect(
      await getDb(ctx.db)
        .select()
        .from(searchDocument)
        .where(eq(searchDocument.entityId, subject.entityId)),
    ).toEqual([]);
    expect((await processDerivedRefreshPage(ctx.db)).processed).toBe(1);
    const [document] = await getDb(ctx.db)
      .select()
      .from(searchDocument)
      .where(eq(searchDocument.entityId, subject.entityId));
    expect(document?.title).toBe("Synthetic newer subject");
  });

  it("cannot rewind a frontier after its lease expires and another page completes", async () => {
    const subject = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prepare = search.prepareSearchDocuments;
    vi.spyOn(search, "prepareSearchDocuments").mockImplementationOnce(
      async (...args) => {
        const result = await prepare(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    const old = processDerivedRefreshPage(ctx.db);
    await entered.promise;
    try {
      await getDb(ctx.db)
        .update(derivedRefreshWork)
        .set({ leaseExpiresAt: new Date(0) });
      expect((await processDerivedRefreshPage(ctx.db)).processed).toBe(1);
      expect((await processDerivedRefreshPage(ctx.db)).processed).toBe(1);
    } finally {
      release.resolve();
    }
    expect(await old).toMatchObject({ processed: 0, errors: [] });
    const [scope] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshScope)
      .where(eq(derivedRefreshScope.entityId, subject.entityId));
    expect(scope?.phase).toBe("recipe");
  });

  it("yields publication contention without consuming the failure budget", async () => {
    const subject = await fixture();
    await search.refreshSearchDocuments(ctx.db, [
      { entityKind: "product", entityId: subject.entityId },
    ]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx).execute(
        sql`SELECT id FROM "SearchDocument" WHERE "entityId"=${subject.entityId}::uuid FOR UPDATE`,
      );
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      expect(await processDerivedRefreshPage(ctx.db)).toMatchObject({
        processed: 0,
        errors: [],
      });
      const [work] = await getDb(ctx.db)
        .select()
        .from(derivedRefreshWork)
        .where(eq(derivedRefreshWork.entityId, subject.entityId));
      expect(work).toMatchObject({
        state: "pending",
        attempts: 0,
        leaseToken: null,
      });
    } finally {
      release.resolve();
      await holder;
    }
    expect((await processDerivedRefreshPage(ctx.db)).processed).toBe(1);
  });

  it("retains a missing-output watermark against older prepared inserts", async () => {
    const subject = await fixture();
    const ref = { entityKind: "product" as const, entityId: subject.entityId };
    const revision = await currentInputRevision(ctx.db);
    const old = await search.prepareSearchDocuments(ctx.db, [ref]);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, subject.entityId));
    await captureDerivedRefresh(ctx.db, [ref]);
    await search.refreshSearchDocuments(ctx.db, [ref]);
    await withTransactionDatabase(ctx.db, async (tx) => {
      expect(
        await search.publishPreparedSearchDocuments(tx, old, revision),
      ).toEqual([]);
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(searchDocument)
        .where(eq(searchDocument.entityId, subject.entityId)),
    ).toEqual([]);
  });
});
