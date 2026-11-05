import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { derivedRebuild } from "~/server/db/derived-rebuild-schema";
import { getDb } from "~/server/db/helpers";
import type { DerivedComputes } from "~/server/generic/derived/repo/compute";
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
} from "./rebuild";

describe("hourly deterministic rebuild", () => {
  const ctx = withTestDb();

  it("shrinks abandoned pages, skips a repeatedly terminated record and refuses stale publication", async () => {
    const first = rebuildDeclarations()[0];
    if (!first) throw new Error("Expected rebuild declaration");
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
    const abandon = async (count: number) => {
      for (let index = 0; index < count; index++) {
        expect(await claimRebuild(ctx.db)).not.toBeNull();
        await getDb(ctx.db).execute(
          sql`UPDATE "DerivedRebuild" SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'`,
        );
      }
    };
    await abandon(3);
    await rebuildDerived(ctx.db, computes, { pageLimit: 1 });
    expect(seen).toEqual([[sorted[0]]]);
    await getDb(ctx.db)
      .execute(sql`INSERT INTO "DerivedValue" ("entityId", kind, key, value, "computedAt") VALUES (${sorted[1]}::uuid, ${first.entity}, ${first.key}, '12'::jsonb, now())
      ON CONFLICT ("entityId", key) DO UPDATE SET value = EXCLUDED.value`);
    await abandon(6);
    await rebuildDerived(ctx.db, computes, { pageLimit: 1 });
    const [skipped] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(skipped).toMatchObject({
      afterId: sorted[1],
      cursorAttempts: 0,
      failures: 1,
    });
    expect(skipped?.error).toContain("repeated isolate termination");
    const retained = await getDb(ctx.db).execute(
      sql`SELECT value FROM "DerivedValue" WHERE "entityId" = ${sorted[1]}::uuid AND key = ${first.key}`,
    );
    expect(retained.rows).toEqual([{ value: 12 }]);
    // Crossing an hour with failures must resume the committed cursor.
    await getDb(ctx.db).execute(
      sql`UPDATE "DerivedRebuild" SET "startedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours'`,
    );
    await rebuildDerived(ctx.db, computes, { pageLimit: 1 });
    expect(seen.at(-1)).toEqual([sorted[2]]);
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
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic isolated provider failure" }),
      ctx.actor,
    );
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
          realPhases.has(key) ? adapter : async () => new Map(),
        ]),
      ),
      "product.price": async () => {
        throw new Error("Synthetic provider unavailable");
      },
    };
    expect(
      await rebuildDerived(ctx.db, computes, { force: true, pageLimit: 1 }),
    ).toBe(true);
    const [failed] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(failed?.target).not.toBe("product.price");
    expect(failed?.failures).toBe(1);
    await getDb(ctx.db).execute(
      sql`UPDATE "DerivedRebuild" SET "startedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours'`,
    );
    expect(
      await rebuildDerived(ctx.db, computes, { deadline: Date.now() + 60_000 }),
    ).toBe(false);
    const [finished] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(finished).toMatchObject({
      running: false,
      failures: 1,
      passFailures: 1,
    });
    expect(finished?.finishedAt).not.toBeNull();
    expect(finished?.error).toContain("Synthetic provider unavailable");
    const output = await getDb(ctx.db).execute(sql`SELECT
      EXISTS (SELECT 1 FROM "QualitySnapshot" WHERE "entityId" = ${product.entityId}::uuid) AS quality,
      EXISTS (SELECT 1 FROM "SearchDocument" WHERE "entityId" = ${product.entityId}::uuid AND "deletedAt" IS NULL) AS search`);
    expect(output.rows).toEqual([{ quality: true, search: true }]);
    // A requested new pass clears an earlier error before its repair stream starts.
    const restarted = await claimRebuild(ctx.db, true);
    expect(restarted?.target).toBe("product.price");
    expect(
      (await getDb(ctx.db).select().from(derivedRebuild))[0]?.error,
    ).toBeNull();
  });
});
