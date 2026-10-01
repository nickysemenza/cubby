import { inventoryReceiveExpenseInput } from "@cubby/schemas/inventory";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense, inventoryEntry, runFinding } from "~/server/db/schema";
import { receiveExpenseInventoryWorkflow } from "~/server/operations/inventory.server";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createInventoryEntry } from "~/server/repo/inventory/crud";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

// Failure modes: stale rendered totals overwrite current stock; a failed
// arrived-finding update leaves inventory committed; receiving a unique item
// creates a second row; an unrelated entry is moved or topped up.
describe("atomic reviewed Expense receiving", () => {
  const ctx = withTestDb();
  async function fixture(unique = false) {
    const good = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Receiving fixture item",
        expectedQuantity: unique ? 1 : null,
      }),
      ctx.actor,
    );
    const place = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Receiving fixture shelf" }),
      ctx.actor,
    );
    const otherPlace = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Receiving fixture other shelf" }),
      ctx.actor,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Receiving fixture merchant",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Receiving fixture line",
      cost: 12,
      date: "2026-09-01",
      costType: "materials",
      purchaseId: purchase.id,
      productId: good.entityId,
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Receiving fixture member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [finding] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        ledgerPartyId: party.id,
        entityKind: "purchase",
        entityId: purchase.id,
        kind: "arrived",
        summary: "Fixture order delivered",
        proposedFix: { kind: "receive_purchase", purchaseId: purchase.id },
        evidenceFingerprint: "receiving-fixture",
      })
      .returning();
    if (!finding) throw new Error("Fixture finding missing");
    return { good, place, otherPlace, line, purchase, finding };
  }
  const receive = (input: unknown) =>
    receiveExpenseInventoryWorkflow(
      ctx.db,
      ctx.actor,
      inventoryReceiveExpenseInput.parse(input),
    );
  const rows = () =>
    getDb(ctx.db)
      .select()
      .from(inventoryEntry)
      .where(notDeleted(inventoryEntry));
  const findingState = async (id: string) =>
    (
      await getDb(ctx.db).select().from(runFinding).where(eq(runFinding.id, id))
    )[0]?.status;

  it("refuses a Product relink after review without stocking or resolving arrival", async () => {
    const f = await fixture();
    const replacement = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Receiving fixture replacement" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(expense)
      .set({ productId: replacement.entityId })
      .where(eq(expense.id, f.line.id));
    await expect(
      receive({
        expenseId: f.line.shortcode,
        expectedProductId: f.good.id,
        locationId: f.place.id,
        action: { kind: "create", amount: { value: 1, unit: "each" } },
      }),
    ).rejects.toThrow(/Product changed/i);
    expect(await rows()).toEqual([]);
    expect(await findingState(f.finding.id)).toBe("open");
    await receive({
      expenseId: f.line.shortcode,
      expectedProductId: replacement.id,
      locationId: f.place.id,
      action: { kind: "create", amount: { value: 1, unit: "each" } },
    });
    expect((await rows())[0]?.productId).toBe(replacement.entityId);
    expect(await findingState(f.finding.id)).toBe("applied");
  });

  it("creates stock only on explicit receive and resolves arrived only when all live product lines are stocked", async () => {
    const f = await fixture();
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Receiving fixture second item" }),
      ctx.actor,
    );
    const secondLine = await insertWithShortcode(ctx.db, "expense", {
      name: "Second line",
      cost: 5,
      date: "2026-09-01",
      costType: "materials",
      purchaseId: f.purchase.id,
      productId: second.entityId,
    });
    expect(await rows()).toHaveLength(0);
    const first = await receive({
      expenseId: f.line.shortcode,
      expectedProductId: f.good.id,
      locationId: f.place.id,
      action: { kind: "create", amount: { value: 2, unit: "each" } },
    });
    expect(first.resolvedArrivedFindings).toBe(0);
    expect(await findingState(f.finding.id)).toBe("open");
    const last = await receive({
      expenseId: secondLine.shortcode,
      expectedProductId: second.id,
      locationId: f.place.id,
      action: { kind: "create", amount: { value: 1, unit: "each" } },
    });
    expect(last.resolvedArrivedFindings).toBe(1);
    expect(await findingState(f.finding.id)).toBe("applied");
    expect(
      (await rows()).map((r) => [r.productId, r.amountValue, r.amountUnit]),
    ).toEqual(
      expect.arrayContaining([
        [f.good.entityId, 2, "each"],
        [second.entityId, 1, "each"],
      ]),
    );
  });

  it("adds to the server's current count and refuses a stale reviewed unit without changing stock", async () => {
    const f = await fixture();
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: f.good.entityId,
        locationId: f.place.entityId,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    // The receiving page may still display 3; another explicit count is now 8.
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ amountValue: 8 })
      .where(eq(inventoryEntry.shortcode, entry.id));
    await receive({
      expenseId: f.line.shortcode,
      expectedProductId: f.good.id,
      locationId: f.place.id,
      action: {
        kind: "add",
        entryId: entry.id,
        amount: { value: 2, unit: "each" },
      },
    });
    expect((await rows())[0]?.amountValue).toBe(10);
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ amountUnit: "kg" })
      .where(eq(inventoryEntry.shortcode, entry.id));
    await expect(
      receive({
        expenseId: f.line.shortcode,
        expectedProductId: f.good.id,
        locationId: f.place.id,
        action: {
          kind: "add",
          entryId: entry.id,
          amount: { value: 2, unit: "each" },
        },
      }),
    ).rejects.toThrow(/unit/i);
    expect((await rows())[0]).toMatchObject({
      amountValue: 10,
      amountUnit: "kg",
    });
  });

  it.each(["create", "add", "move"] as const)(
    "rolls back %s when resolving the arrived finding fails",
    async (kind) => {
      const f = await fixture();
      const entry =
        kind === "create"
          ? null
          : await createInventoryEntry(
              ctx.db,
              {
                productId: f.good.entityId,
                locationId: f.place.entityId,
                amount: { value: 3, unit: "each" },
              },
              ctx.actor,
            );
      const before = await rows();
      await getDb(ctx.db).execute(
        sql`ALTER TABLE "RunFinding" ADD CONSTRAINT receiving_fixture_refuse_apply CHECK (status <> 'applied')`,
      );
      const action =
        kind === "create"
          ? { kind, amount: { value: 1, unit: "each" } }
          : kind === "add"
            ? { kind, entryId: entry!.id, amount: { value: 2, unit: "each" } }
            : { kind, entryId: entry!.id };
      try {
        await expect(
          receive({
            expenseId: f.line.shortcode,
            expectedProductId: f.good.id,
            locationId: kind === "move" ? f.otherPlace.id : f.place.id,
            action,
          }),
        ).rejects.toMatchObject({
          cause: {
            code: "23514",
            constraint: "receiving_fixture_refuse_apply",
          },
        });
        expect(await rows()).toEqual(before);
        expect(await findingState(f.finding.id)).toBe("open");
      } finally {
        await getDb(ctx.db).execute(
          sql`ALTER TABLE "RunFinding" DROP CONSTRAINT receiving_fixture_refuse_apply`,
        );
      }
    },
  );

  it("moves a one-of-a-kind item while rejecting add/create choices that would duplicate it", async () => {
    const f = await fixture(true);
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: f.good.entityId,
        locationId: f.place.entityId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      receive({
        expenseId: f.line.shortcode,
        expectedProductId: f.good.id,
        locationId: f.place.id,
        action: {
          kind: "add",
          entryId: entry.id,
          amount: { value: 1, unit: "each" },
        },
      }),
    ).rejects.toThrow(/one-of-a-kind/i);
    await expect(
      receive({
        expenseId: f.line.shortcode,
        expectedProductId: f.good.id,
        locationId: f.otherPlace.id,
        action: { kind: "create", amount: { value: 1, unit: "each" } },
      }),
    ).rejects.toThrow(/one-of-a-kind/i);
    await receive({
      expenseId: f.line.shortcode,
      expectedProductId: f.good.id,
      locationId: f.otherPlace.id,
      action: { kind: "move", entryId: entry.id },
    });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      productId: f.good.entityId,
      locationId: f.otherPlace.entityId,
      amountValue: 1,
      amountUnit: "each",
    });
    expect(await findingState(f.finding.id)).toBe("applied");
  });

  it("rejects another product's entry and a deleted Expense without touching inventory or the finding", async () => {
    const f = await fixture();
    const other = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Receiving fixture unrelated item" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: other.entityId,
        locationId: f.place.entityId,
        amount: { value: 5, unit: "each" },
      },
      ctx.actor,
    );
    const before = await rows();
    await expect(
      receive({
        expenseId: f.line.shortcode,
        expectedProductId: f.good.id,
        locationId: f.otherPlace.id,
        action: { kind: "move", entryId: entry.id },
      }),
    ).rejects.toThrow(/Expense Product/);
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(and(eq(expense.id, f.line.id), notDeleted(expense)));
    await expect(
      receive({
        expenseId: f.line.shortcode,
        expectedProductId: f.good.id,
        locationId: f.place.id,
        action: { kind: "create", amount: { value: 1, unit: "each" } },
      }),
    ).rejects.toThrow(/not found|deleted|does not exist/i);
    expect(await rows()).toEqual(before);
    expect(await findingState(f.finding.id)).toBe("open");
  });
  it("rejects nonpositive, unitless or ranged receive amounts before any write", async () => {
    const f = await fixture();
    for (const amount of [
      { value: 0, unit: "each" },
      { value: 1, unit: "" },
      { value: 1, unit: "each", upperValue: 2 },
    ]) {
      expect(() =>
        receive({
          expenseId: f.line.shortcode,
          expectedProductId: f.good.id,
          locationId: f.place.id,
          action: { kind: "create", amount },
        }),
      ).toThrow(/amount|unit/i);
    }
    expect(await rows()).toHaveLength(0);
    expect(await findingState(f.finding.id)).toBe("open");
  });
});
