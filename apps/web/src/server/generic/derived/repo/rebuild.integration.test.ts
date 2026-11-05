import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { derivedRebuild } from "~/server/db/derived-rebuild-schema";
import { getDb } from "~/server/db/helpers";
import { rebuildDerived } from "~/server/generic/derived/service/rebuild";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

import { claimRebuild, rebuildDeclarations, releaseRebuild } from "./rebuild";

describe("hourly deterministic rebuild", () => {
  const ctx = withTestDb();

  it("resumes the committed cursor after a failed page and excludes overlapping invocations", async () => {
    const first = rebuildDeclarations()[0];
    expect(first?.target).toBe("product.price");
    const products = await Promise.all(
      ["Synthetic first", "Synthetic second"].map((name) =>
        createProductIdentityFixture(
          ctx.db,
          makeProductInput({ name }),
          ctx.actor,
        ),
      ),
    );
    const seen: string[] = [];
    let fail = false;
    const computes = {
      ...derivedComputes,
      "product.price": Object.assign(
        async (
          _db: Parameters<typeof rebuildDerived>[0],
          ids: readonly string[],
        ) => {
          seen.push(...ids);
          if (fail) throw new Error("Synthetic interrupted page");
          return new Map(ids.map((id) => [id, { value: 12, sort: 12 }]));
        },
        { preparationBatchSize: 1 },
      ),
    };
    expect(await rebuildDerived(ctx.db, computes, { pageLimit: 1 })).toBe(true);
    const [committed] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(committed?.afterId).toBe(seen[0]);
    fail = true;
    await expect(
      rebuildDerived(ctx.db, computes, { pageLimit: 1 }),
    ).rejects.toThrow("Synthetic interrupted page");
    const [retained] = await getDb(ctx.db).select().from(derivedRebuild);
    expect(retained?.afterId).toBe(committed?.afterId);
    expect(retained?.failures).toBe(1);
    fail = false;
    await rebuildDerived(ctx.db, computes, { pageLimit: 1 });
    expect(seen[2]).toBe(seen[1]);
    expect(products.map((product) => product.entityId).sort()).toEqual([
      seen[0],
      seen[2],
    ]);
    const held = await claimRebuild(ctx.db);
    expect(held).not.toBeNull();
    expect(await claimRebuild(ctx.db)).toBeNull();
    if (!held) throw new Error("Expected coarse pass lease");
    await releaseRebuild(ctx.db, held.token);

    await getDb(ctx.db).execute(sql`UPDATE "DerivedRebuild" SET failures = 1,
      "startedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours'`);
    await rebuildDerived(ctx.db, computes, { pageLimit: 1 });
    expect(seen.at(-1)).toBe(seen[0]);
    const output = await getDb(ctx.db).execute(
      sql`SELECT count(*)::int AS count FROM "DerivedValue" WHERE key = ${first?.key} AND value = '12'::jsonb`,
    );
    expect(output.rows).toEqual([{ count: 2 }]);
  });
});
