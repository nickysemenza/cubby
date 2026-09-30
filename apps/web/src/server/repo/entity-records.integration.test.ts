import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityRecordsInputSchema } from "~/contracts/entity-records.schema";
import { product, run as runTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  buildEntityRecordsQuery,
  listEntityRecords,
} from "~/server/repo/entity-records";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { ensureRun } from "~/server/runs/ensure-run";

// Regressions: paging before sorting/filtering, payload updates confused with
// identity creation, deleted identities leaking, and unscored rows called 100%.
describe("combined entity records", () => {
  const ctx = withTestDb();
  it("evaluates default-list quality and image subplans only for the requested page", async () => {
    for (let i = 0; i < 30; i++) {
      await createProductFixture(
        ctx.db,
        makeProductInput({ name: `Page cost product ${i}` }),
        ctx.actor,
      );
    }
    const result = await getDb(ctx.db).execute(sql`
      EXPLAIN (ANALYZE, FORMAT JSON) ${buildEntityRecordsQuery(
        entityRecordsInputSchema.parse({ kind: "product", pageSize: 3 }),
      )}
    `);
    type Plan = {
      "Parent Relationship"?: string;
      "Actual Loops": number;
      Plans?: Plan[];
    };
    // SAFETY: EXPLAIN (ANALYZE, FORMAT JSON) returns a plan tree with loop counts.
    const document = result.rows[0]!["QUERY PLAN"] as { Plan: Plan }[];
    const loops: number[] = [];
    const visit = (plan: Plan) => {
      if (plan["Parent Relationship"] === "SubPlan")
        loops.push(plan["Actual Loops"]);
      plan.Plans?.forEach(visit);
    };
    visit(document[0]!.Plan);
    expect(loops.length).toBeGreaterThan(0);
    expect(Math.max(...loops)).toBeLessThanOrEqual(3);
  });
  it("sorts and pages one filtered roster across payload kinds", async () => {
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Records roster Alpha" }),
      ctx.actor,
    );
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Records roster Zulu" }),
      ctx.actor,
    );
    const first = await listEntityRecords(
      ctx.db,
      entityRecordsInputSchema.parse({
        q: "Records roster",
        orderBy: "name",
        direction: "asc",
        pageSize: 1,
      }),
    );
    expect(first.totalCount).toBe(2);
    expect(first.items.map((row) => row.id)).toEqual([location.id]);
    const defaultPage = await listEntityRecords(
      ctx.db,
      entityRecordsInputSchema.parse({}),
    );
    expect(defaultPage.items.map((row) => row.id)).toEqual(
      expect.arrayContaining([location.id, item.id]),
    );
    expect(defaultPage.items.find((row) => row.id === item.id)?.name).toBe(
      "Records roster Zulu",
    );
    const second = await listEntityRecords(
      ctx.db,
      entityRecordsInputSchema.parse({
        q: "Records roster",
        orderBy: "name",
        direction: "asc",
        pageSize: 1,
        page: 2,
      }),
    );
    expect(second.items.map((row) => row.id)).toEqual([item.id]);
    expect(first.items[0]?.quality).toBeGreaterThanOrEqual(0);
    expect(first.items[0]?.quality).toBeLessThanOrEqual(100);
    expect(
      (
        await listEntityRecords(
          ctx.db,
          entityRecordsInputSchema.parse({
            q: "Records roster",
            kind: "product",
          }),
        )
      ).items.map((row) => row.id),
    ).toEqual([item.id]);
  });

  it("filters payload timestamps and removes deleted records from rows and counts", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Records timestamps" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ updatedAt: new Date("2025-03-01T12:00:00Z") })
      .where(eq(product.shortcode, item.id));
    const input = entityRecordsInputSchema.parse({
      q: "Records timestamps",
      updatedFrom: "2025-03-01",
      updatedTo: "2025-03-01",
    });
    expect(
      (await listEntityRecords(ctx.db, input)).items.map((row) => row.id),
    ).toEqual([item.id]);
    expect(
      (await listEntityRecords(ctx.db, { ...input, updatedFrom: "2025-03-02" }))
        .totalCount,
    ).toBe(0);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.shortcode, item.id));
    expect(await listEntityRecords(ctx.db, input)).toMatchObject({
      items: [],
      totalCount: 0,
    });
  });

  it("leaves unscored identities null and excludes them from numeric quality ranges", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const [identity] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));
    expect(identity).toBeDefined();
    const input = entityRecordsInputSchema.parse({
      kind: "run",
      q: identity!.shortcode,
    });
    expect((await listEntityRecords(ctx.db, input)).items).toMatchObject([
      { id: identity!.shortcode, quality: null },
    ]);
    expect(
      await listEntityRecords(ctx.db, { ...input, qualityMin: 0 }),
    ).toMatchObject({ items: [], totalCount: 0 });
  });
});
