import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { kernelPass } from "~/server/db/kernel-schema";
import {
  derivedSink,
  type DerivedComputes,
} from "~/server/generic/derived/repo/compute";
import {
  readSnapshotState,
  snapshotCursor,
  DERIVED_SNAPSHOT_PASS,
} from "~/server/generic/derived/repo/snapshot-state";
import { runSnapshotPage } from "~/server/generic/derived/snapshot.fixtures";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

import { rebuildDeclarations, requestDerivedRebuild } from "./rebuild";

describe("hourly deterministic snapshot Pass", () => {
  const ctx = withTestDb();
  const cursor = async () =>
    snapshotCursor(
      (
        await getDb(ctx.db)
          .select()
          .from(kernelPass)
          .where(eq(kernelPass.name, DERIVED_SNAPSHOT_PASS))
      )[0]?.cursor,
    );
  const stubbed = (): DerivedComputes =>
    Object.fromEntries(
      Object.keys(derivedComputes).map((key) => [
        key,
        derivedSink({ prepare: async () => null, publish: async () => {} }),
      ]),
    );
  const complete = async (computes: DerivedComputes) => {
    for (let page = 0; page < 500; page++)
      if (!(await runSnapshotPage(ctx.db, computes))) return;
    throw new Error("Synthetic snapshot did not finish");
  };
  const products = (names: string[]) =>
    Promise.all(
      names.map((name) =>
        createProductIdentityFixture(
          ctx.db,
          makeProductInput({ name }),
          ctx.actor,
        ),
      ),
    );

  it("shrinks abandoned pages and retains the prior value when a repeatedly terminated record is skipped", async () => {
    const ids = (
      await products(["Synthetic first", "Synthetic second", "Synthetic third"])
    )
      .map((row) => row.entityId)
      .sort();
    const seen: string[][] = [];
    const computes = {
      ...stubbed(),
      "product.price": Object.assign(
        async (_db: typeof ctx.db, page: readonly string[]) => {
          seen.push([...page]);
          return new Map(page.map((id) => [id, { value: 99, sort: 99 }]));
        },
        { preparationBatchSize: 2 },
      ),
    };
    expect(await requestDerivedRebuild(ctx.db)).toEqual({ existing: false });
    expect(await requestDerivedRebuild(ctx.db)).toEqual({ existing: true });
    expect((await cursor()).cursorAttempts).toBe(0);
    const price = rebuildDeclarations().find(
      (entry) => entry.compute === "product.price",
    )!;
    await getDb(ctx.db)
      .update(kernelPass)
      .set({
        cursor: {
          ...(await cursor()),
          target: price.target,
          cursorAttempts: 3,
        },
      })
      .where(eq(kernelPass.name, DERIVED_SNAPSHOT_PASS));
    await runSnapshotPage(ctx.db, computes);
    expect(seen[0]).toEqual([ids[0]]);
    await getDb(ctx.db).execute(
      sql`INSERT INTO "ProductReadSnapshot" ("entityId", price, "priceComputedAt") VALUES (${ids[1]}::uuid, 12, now()) ON CONFLICT ("entityId") DO UPDATE SET price = excluded.price`,
    );
    await getDb(ctx.db)
      .update(kernelPass)
      .set({
        cursor: {
          ...(await cursor()),
          target: price.target,
          afterId: ids[0]!,
          cursorAttempts: 7,
        },
      })
      .where(eq(kernelPass.name, DERIVED_SNAPSHOT_PASS));
    seen.length = 0;
    await complete(computes);
    expect(seen.some((page) => page.includes(ids[1]!))).toBe(false);
    expect(await readSnapshotState(ctx.db)).toMatchObject({
      running: false,
      failures: 1,
      error: expect.stringContaining("repeated isolate termination"),
    });
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT price AS value FROM "ProductReadSnapshot" WHERE "entityId" = ${ids[1]}::uuid`,
        "objects",
      ),
    ).toEqual([{ value: 12 }]);
  });

  it("retains a failed target and completes later quality and search with the failure visible", async () => {
    const rows = await products([
      "Synthetic first",
      "Synthetic failed page",
      "Synthetic last",
    ]);
    const ids = rows.map((row) => row.entityId).sort();
    const realPhases = new Set(
      rebuildDeclarations()
        .filter(
          (entry) =>
            entry.rebuildPhase === "quality" || entry.rebuildPhase === "search",
        )
        .map((entry) => entry.compute),
    );
    const computes = {
      ...stubbed(),
      ...Object.fromEntries(
        Object.entries(derivedComputes).filter(([key]) => realPhases.has(key)),
      ),
      "product.price": Object.assign(
        async (_db: typeof ctx.db, page: readonly string[]) => {
          if (page.includes(ids[1]!))
            throw new Error("Synthetic provider unavailable");
          return new Map(page.map((id) => [id, { value: 12, sort: 12 }]));
        },
        { preparationBatchSize: 1 },
      ),
    };
    await requestDerivedRebuild(ctx.db);
    await complete(computes);
    expect(await readSnapshotState(ctx.db)).toMatchObject({
      running: false,
      failures: 1,
      failedPages: 1,
      finishedAt: expect.any(String),
      error: expect.stringContaining("Synthetic provider unavailable"),
    });
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT EXISTS (SELECT 1 FROM "QualitySnapshot" WHERE "entityId" = ${ids[0]}::uuid) AS quality, EXISTS (SELECT 1 FROM "SearchDocument" WHERE "entityId" = ${ids[0]}::uuid AND "deletedAt" IS NULL) AS search`,
        "objects",
      ),
    ).toEqual([{ quality: true, search: true }]);
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT price AS value FROM "ProductReadSnapshot" WHERE "entityId" = ${ids[2]}::uuid`,
        "objects",
      ),
    ).toEqual([{ value: 12 }]);
    await requestDerivedRebuild(ctx.db, { force: false });
    expect((await readSnapshotState(ctx.db)).running).toBe(false);
    await requestDerivedRebuild(ctx.db);
    expect(await readSnapshotState(ctx.db)).toMatchObject({
      running: true,
      error: null,
    });
  });

  it("retries a dropped connection on the same cursor without counting a failure", async () => {
    await products(["Synthetic connection drop"]);
    const first = rebuildDeclarations()[0]!;
    const dropped = new Error("Failed query: begin", {
      cause: new Error("Connection terminated unexpectedly"),
    });
    const computes = {
      ...stubbed(),
      [first.compute]: Object.assign(
        async () => {
          throw dropped;
        },
        { preparationBatchSize: 1 },
      ),
    };
    await requestDerivedRebuild(ctx.db);
    await runSnapshotPage(ctx.db, computes);
    expect(await cursor()).toMatchObject({
      target: first.target,
      afterId: null,
      cursorAttempts: 1,
      failures: 0,
      passFailures: 0,
      failedPages: 0,
    });
    expect((await cursor()).error).toContain(
      "Connection terminated unexpectedly",
    );
    for (let retry = 0; retry < 3; retry++) {
      await getDb(ctx.db)
        .update(kernelPass)
        .set({ availableAt: new Date(0) })
        .where(eq(kernelPass.name, DERIVED_SNAPSHOT_PASS));
      await runSnapshotPage(ctx.db, computes);
    }
    expect(await cursor()).toMatchObject({
      failures: 1,
      error: expect.stringContaining("repeated isolate termination"),
    });
    expect((await cursor()).error).toContain(
      "Connection terminated unexpectedly",
    );
  });
});
