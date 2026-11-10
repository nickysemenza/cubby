import { systemActor } from "@cubby/schemas/context";
import { eq, sql } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { fieldAutomationDrain } from "~/server/domains/run/service/field-automation";
import {
  categoryPorts,
  kernelCtx,
  productFixture,
  startSuggestionSweep,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";

type Ctx = ReturnType<typeof withTestDb>;

const decisionsOf = async (ctx: Ctx, id: string) =>
  (
    await getDb(ctx.db).execute<{ verdict: string; authority: string }>(
      sql`SELECT d->>'verdict' AS verdict, d->>'authority' AS authority
        FROM "Suggestion" s CROSS JOIN LATERAL jsonb_array_elements(s.decisions) d
        WHERE s.id = ${id}::uuid AND d->>'operationId' LIKE 'correction:%'`,
    )
  ).rows;

const drainEvents = async (ctx: Ctx) => {
  for (let page = 0; page < 5; page += 1)
    if ((await fieldAutomationDrain.page(ctx.db, "events")).claimed === 0)
      return;
};

// Failure mode: field automation loses or duplicates a member's correction of
// Cubby's value, or grades an import's write as a member's verdict.
describe("field automation drain", () => {
  const ctx = withTestDb();

  const cubbyValue = async (name: string) => {
    const item = await productFixture(ctx, name);
    const sweep = await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.9) },
    );
    const [applied] = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(eq(suggestionTable.runId, sweep.id));
    expect(applied?.status).toBe("applied");
    await drainEvents(ctx);
    return { item, suggestionId: applied!.id };
  };

  const write = (id: string, actorContext = kernelCtx(ctx).actorContext) =>
    executeEntity(
      { ...kernelCtx(ctx), actorContext },
      entityCommandSchema.parse({
        action: "update",
        entity: "product",
        id,
        data: { categoryId: taxonomyShortcode("tools") },
      }),
    );

  it("records a member's edit of Cubby's value as one Miss, even when replayed", async () => {
    const { item, suggestionId } = await cubbyValue(
      "Synthetic corrected value",
    );
    await write(item.id);
    await drainEvents(ctx);
    // A replayed page (a lapsed permit) must not grade twice.
    await getDb(ctx.db).execute(
      sql`UPDATE "AuditLog" SET "automationPending" = true
        WHERE "entityKind" = ${"product"} AND changes ? ${"categoryId"} AND authority IS NULL`,
    );
    await drainEvents(ctx);
    expect(await decisionsOf(ctx, suggestionId)).toEqual([
      { verdict: "wrong", authority: "member" },
    ]);
    const [row] = await getDb(ctx.db)
      .select({
        status: suggestionTable.status,
        correctValue: suggestionTable.correctValue,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, suggestionId));
    expect(row?.status).toBe("rejected");
    expect(row?.correctValue).not.toBeNull();
    const pending = await getDb(ctx.db).execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM "AuditLog" WHERE "automationPending"`,
    );
    expect(pending.rows[0]?.count).toBe(0);
  });

  it("treats an import's replacement as evidence, not a member's grade", async () => {
    const { item, suggestionId } = await cubbyValue("Synthetic imported value");
    await write(item.id, systemActor());
    await drainEvents(ctx);
    expect(await decisionsOf(ctx, suggestionId)).toEqual([]);
  });
});
