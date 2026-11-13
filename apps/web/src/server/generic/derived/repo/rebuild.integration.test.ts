import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { derivedRebuild } from "~/server/db/derived-rebuild-schema";
import { getDb } from "~/server/db/helpers";
import {
  derivedSink,
  type DerivedAdapter,
  type DerivedComputes,
} from "~/server/generic/derived/repo/compute";
import { rebuildDerived } from "~/server/generic/derived/service/rebuild";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

import {
  claimRebuild,
  commitRebuildPage,
  rebuildDeclarations,
  requestDerivedRebuild,
} from "./rebuild";

describe("hourly deterministic rebuild", () => {
  const ctx = withTestDb();

  it("shrinks abandoned pages, skips a repeatedly terminated record and refuses stale publication", async () => {
    const products = await Promise.all(
      ["Synthetic first", "Synthetic second", "Synthetic third"].map((name) =>
        createProductIdentityFixture(
          ctx.db,
          makeProductInput({ name }),
          ctx.actor,
        ),
      ),
    );
    const sorted = products.map((product) => product.entityId).sort();
    const seen: string[][] = [];
    const computes = {
      ...derivedComputes,
      "product.price": Object.assign(
        async (
          _db: Parameters<typeof rebuildDerived>[0],
          ids: readonly string[],
        ) => {
          seen.push([...ids]);
          return new Map(ids.map((id) => [id, { value: 99, sort: 99 }]));
        },
        { preparationBatchSize: 2 },
      ),
    };
    // Repair requests join the active pass and never count as failed compute attempts.
    await requestDerivedRebuild(ctx.db);
    await requestDerivedRebuild(ctx.db);
    expect(
      (await getDb(ctx.db).select().from(derivedRebuild))[0]?.cursorAttempts,
    ).toBe(0);
    const abandon = async (count: number) => {
      for (let index = 0; index < count; index++) {
        expect(await claimRebuild(ctx.db)).not.toBeNull();
        await getDb(ctx.db).execute(
          sql`UPDATE "DerivedRebuild" SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'`,
        );
      }
    };
    await abandon(3);
    await rebuildDerived(ctx.db, computes);
    // The first page of a contended cursor is still one record. Later pages
    // in the same call continue under the wall budget.
    expect(seen[0]).toEqual([sorted[0]]);
    const price = rebuildDeclarations().find(
      (declaration) => declaration.compute === "product.price",
    );
    if (!price) throw new Error("Expected the product price declaration");
    const skippedId = sorted[1];
    if (!skippedId) throw new Error("Expected a second product");
    await getDb(ctx.db)
      .execute(sql`INSERT INTO "ProductReadSnapshot" ("entityId", price, "priceComputedAt") VALUES (${skippedId}::uuid, 12, now())
      ON CONFLICT ("entityId") DO UPDATE SET price = EXCLUDED.price`);
    await getDb(ctx.db).execute(sql`
      UPDATE "DerivedRebuild" SET
        running = true,
        target = ${price.target},
        "afterId" = ${sorted[0]}::uuid,
        "cursorAttempts" = 7,
        "startedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours',
        token = NULL,
        "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'`);
    seen.length = 0;
    await rebuildDerived(ctx.db, computes);
    expect(seen.some((page) => page.includes(skippedId))).toBe(false);
    const [skipped] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(skipped?.failures).toBeGreaterThanOrEqual(1);
    expect(skipped?.error).toContain("repeated isolate termination");
    const retained = await getDb(ctx.db).execute(
      sql`SELECT price AS value FROM "ProductReadSnapshot" WHERE "entityId" = ${skippedId}::uuid`,
      "objects",
    );
    expect(retained).toEqual([{ value: 12 }]);
    await getDb(ctx.db).execute(
      sql`UPDATE "DerivedRebuild" SET "startedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours',
        "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'`,
    );
    const old = await claimRebuild(ctx.db);
    expect(old).not.toBeNull();
    expect(await claimRebuild(ctx.db)).toBeNull();
    await getDb(ctx.db).execute(
      sql`UPDATE "DerivedRebuild" SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'`,
    );
    expect(await claimRebuild(ctx.db)).not.toBeNull();
    if (!old) throw new Error("Expected coarse lease");
    let published = false;
    expect(
      await commitRebuildPage(ctx.db, old, null, async () => {
        published = true;
      }),
    ).toBe(false);
    expect(published).toBe(false);
  });

  it("retains a failed target and completes later quality and search with the failure visible", async () => {
    const products = await Promise.all(
      [
        "Synthetic before failure",
        "Synthetic failed page",
        "Synthetic after failure",
      ].map((name) =>
        createProductIdentityFixture(
          ctx.db,
          makeProductInput({ name }),
          ctx.actor,
        ),
      ),
    );
    const ids = products.map((product) => product.entityId).sort();
    const product = products[0];
    if (!product) throw new Error("Expected synthetic product");
    const realPhases = new Set(
      rebuildDeclarations()
        .filter(
          (declaration) =>
            declaration.rebuildPhase === "quality" ||
            declaration.rebuildPhase === "search",
        )
        .map((declaration) => declaration.compute),
    );
    const computes: DerivedComputes = {
      ...Object.fromEntries(
        Object.entries(derivedComputes).map(([key, adapter]) => [
          key,
          realPhases.has(key)
            ? adapter
            : derivedSink({
                prepare: async () => null,
                publish: async () => {},
              }),
        ]),
      ),
      "product.price": Object.assign(
        async (
          _db: Parameters<typeof rebuildDerived>[0],
          pageIds: readonly string[],
        ) => {
          if (pageIds.includes(ids[1] ?? ""))
            throw new Error("Synthetic provider unavailable");
          return new Map(pageIds.map((id) => [id, { value: 12, sort: 12 }]));
        },
        { preparationBatchSize: 1 },
      ),
    };
    let steps = 0;
    let advanced = await rebuildDerived(ctx.db, computes, { force: true });
    while (advanced) {
      if (++steps > 100) throw new Error("Synthetic pass did not finish");
      advanced = await rebuildDerived(ctx.db, computes);
    }
    const [finished] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(finished).toMatchObject({
      running: false,
      failures: 1,
      passFailures: 1,
    });
    expect(finished?.finishedAt).not.toBeNull();
    expect(finished?.error).toContain("Synthetic provider unavailable");
    const output = await getDb(ctx.db).execute(
      sql`SELECT
      EXISTS (SELECT 1 FROM "QualitySnapshot" WHERE "entityId" = ${product.entityId}::uuid) AS quality,
      EXISTS (SELECT 1 FROM "SearchDocument" WHERE "entityId" = ${product.entityId}::uuid AND "deletedAt" IS NULL) AS search`,
      "objects",
    );
    expect(output).toEqual([{ quality: true, search: true }]);
    const later = await getDb(ctx.db).execute(
      sql`SELECT price AS value FROM "ProductReadSnapshot" WHERE "entityId" = ${ids[2]}::uuid`,
      "objects",
    );
    expect(later).toEqual([{ value: 12 }]);
    // A failed completed pass cannot bypass the hourly gate or schedule a new full pass.
    await getDb(ctx.db).execute(
      sql`UPDATE "DerivedRebuild" SET "startedAt" = now() AT TIME ZONE 'UTC'`,
    );
    expect(await claimRebuild(ctx.db)).toBeNull();
    // A requested new pass clears an earlier error before its repair stream starts.
    const restarted = await claimRebuild(ctx.db, true);
    expect(restarted?.target).toBe("product.price");
    expect(
      (await getDb(ctx.db).select().from(derivedRebuild))[0]?.error,
    ).toBeNull();
  });

  it("retries a dropped connection on the same cursor without counting a failure", async () => {
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic connection drop" }),
      ctx.actor,
    );
    const dropped = new Error("Failed query: begin", {
      cause: new Error("Connection terminated unexpectedly"),
    });
    const start = rebuildDeclarations()[0];
    if (!start) throw new Error("Expected a rebuild declaration");
    const computes: DerivedComputes = Object.fromEntries(
      Object.keys(derivedComputes).map((key): [string, DerivedAdapter] => [
        key,
        key === start.compute
          ? Object.assign(
              async () => {
                throw dropped;
              },
              { preparationBatchSize: 1 },
            )
          : derivedSink({
              prepare: async () => null,
              publish: async () => {},
            }),
      ]),
    );
    let thrown: unknown;
    try {
      await rebuildDerived(ctx.db, computes, { force: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(dropped);
    const [once] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(once).toMatchObject({
      target: start.target,
      afterId: null,
      cursorAttempts: 1,
      failures: 0,
      passFailures: 0,
      failedPages: 0,
      token: null,
    });
    expect(once?.error).toContain("Connection terminated unexpectedly");
    // Batch size 1 skips once attempts exceed 3 * (floor(log2(1)) + 1).
    const skipAfter = 3 * (Math.floor(Math.log2(1)) + 1);
    const drops: unknown[] = [];
    for (let extra = 0; extra < skipAfter; extra++) {
      try {
        await rebuildDerived(ctx.db, computes);
        break;
      } catch (error) {
        drops.push(error);
      }
    }
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((error) => error === dropped)).toBe(true);
    const [bounded] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(bounded?.failures).toBe(1);
    expect(bounded?.error).toContain("repeated isolate termination");
    // The skip keeps the drop that caused it.
    expect(bounded?.error).toContain("Connection terminated unexpectedly");
  });
});
