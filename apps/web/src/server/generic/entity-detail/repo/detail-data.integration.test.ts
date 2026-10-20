import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { auditLog, expense } from "~/server/db/schema";

import { getDetailActivity, getMonthlyExpenseSpend } from "./detail-data";

// Failure modes: gaps disappear; stated totals replace Expense.cost; duplicate
// relation paths multiply spend; unselected relations leak into the timeline;
// equal timestamps skip/repeat events across a cursor; audits sort separately.
describe("declared detail data", () => {
  const ctx = withTestDb();

  it("executes each declared chart and activity path for an absent source", async () => {
    const sources = allEntities.flatMap((entity) => {
      const descriptor = entityManifest[entity];
      const prefix =
        "shortcodePrefix" in descriptor ? descriptor.shortcodePrefix : null;
      return prefix ? [{ entityKind: entity, entityId: `${prefix}2345` }] : [];
    });
    for (const source of sources.filter(
      (source) => entitySummary[source.entityKind].detail.hero.chart,
    )) {
      const series = await getMonthlyExpenseSpend(
        ctx.db,
        { source },
        "2026-10-20",
      );
      expect(series).toHaveLength(12);
      expect(series.every((point) => point.cents === 0)).toBe(true);
    }
    for (const source of sources.filter(
      (source) =>
        entitySummary[source.entityKind].detail.activityRelations.length,
    )) {
      expect(await getDetailActivity(ctx.db, { source })).toEqual({
        items: [],
        nextCursor: null,
      });
    }
  });

  it("zero-fills twelve months and sums only distinct live, actual Expense costs", async () => {
    const vendor = await createRepoEntity(ctx, "vendor");
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-08",
      statedTotal: 9000,
    });
    await createRepoEntity(ctx, "expense", {
      trade: "other",
      purchaseId: purchase.output.id,
      date: "2026-09-08",
      cost: 12.34,
    });
    await createRepoEntity(ctx, "expense", {
      trade: "other",
      purchaseId: purchase.output.id,
      date: "2026-09-09",
      cost: -2,
    });
    await createRepoEntity(ctx, "expense", {
      trade: "other",
      purchaseId: purchase.output.id,
      date: "2026-10-02",
      cost: 100,
      future: true,
    });
    const removed = await createRepoEntity(ctx, "expense", {
      trade: "other",
      purchaseId: purchase.output.id,
      date: "2026-09-10",
      cost: 300,
    });
    await unwrapDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, removed.entityId));
    const input = {
      source: { entityKind: "vendor" as const, entityId: vendor.output.id },
    };
    const series = await getMonthlyExpenseSpend(ctx.db, input, "2026-10-20");
    expect(series).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        month:
          index < 2
            ? `2025-${index + 11}`
            : `2026-${String(index - 1).padStart(2, "0")}`,
        cents: index === 10 ? 1034 : 0,
      })),
    );
    const account = await createRepoEntity(ctx, "financialAccount");
    for (const amount of [700, 800]) {
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        purchaseId: purchase.output.id,
        amount,
      });
    }
    expect(
      await getMonthlyExpenseSpend(
        ctx.db,
        {
          source: {
            entityKind: "financialAccount",
            entityId: account.output.id,
          },
        },
        "2026-10-20",
      ),
    ).toEqual(series);
    const empty = await createRepoEntity(ctx, "vendor", {
      name: "Empty example vendor",
    });
    expect(
      (
        await getMonthlyExpenseSpend(
          ctx.db,
          { source: { entityKind: "vendor", entityId: empty.output.id } },
          "2026-10-20",
        )
      ).every((point) => point.cents === 0),
    ).toBe(true);
  });

  it("merges opted-in records and audits with stable cursors and entity filtering", async () => {
    const vendor = await createRepoEntity(ctx, "vendor");
    await unwrapDb(ctx.db)
      .delete(auditLog)
      .where(eq(auditLog.entityId, vendor.entityId));
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-08",
      statedTotal: 999,
    });
    const first = await createRepoEntity(ctx, "expense", {
      trade: "other",
      purchaseId: purchase.output.id,
      date: "2026-09-10",
      cost: 3.21,
    });
    const second = await createRepoEntity(ctx, "expense", {
      trade: "other",
      purchaseId: purchase.output.id,
      date: "2026-09-10",
      cost: 4.56,
    });
    // A dated but non-opted-in target must not appear (Vendor.transactions).
    const account = await createRepoEntity(ctx, "financialAccount");
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      purchaseId: purchase.output.id,
      transactionDate: "2026-09-15",
      amount: 888,
    });
    await unwrapDb(ctx.db)
      .insert(auditLog)
      .values({
        entityKind: "vendor",
        entityId: vendor.entityId,
        action: "update",
        changes: { name: { from: "Example", to: "Updated example" } },
        userId: ctx.actor.userId,
        createdAt: sql`${"2026-09-09T12:00:00.000900"}::timestamp`,
      });
    await unwrapDb(ctx.db)
      .insert(auditLog)
      .values({
        entityKind: "vendor",
        entityId: vendor.entityId,
        action: "update",
        changes: { notes: { from: null, to: "Example note" } },
        userId: ctx.actor.userId,
        createdAt: sql`${"2026-09-09T12:00:00.000100"}::timestamp`,
      });
    const source = {
      entityKind: "vendor" as const,
      entityId: vendor.output.id,
    };
    const all = await getDetailActivity(ctx.db, { source, limit: 50 });
    expect(
      all.items.map((event) =>
        event.kind === "record" ? event.shortcode : "change",
      ),
    ).toEqual([
      ...[first.output.id, second.output.id].sort().reverse(),
      "change",
      "change",
      purchase.output.id,
    ]);
    expect(
      all.items
        .filter((event) => event.entity === "expense")
        .map((event) => event.amountCents)
        .sort(),
    ).toEqual([321, 456]);
    expect(
      all.items.find((event) => event.entity === "purchase")?.amountCents,
    ).toBeUndefined();
    const paged: typeof all.items = [];
    let cursor: string | undefined;
    do {
      const page = await getDetailActivity(ctx.db, {
        source,
        limit: 1,
        cursor,
      });
      paged.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(all.items);
    expect(
      (await getDetailActivity(ctx.db, { source, entity: "expense" })).items,
    ).toEqual(all.items.filter((event) => event.entity === "expense"));
  });
});
