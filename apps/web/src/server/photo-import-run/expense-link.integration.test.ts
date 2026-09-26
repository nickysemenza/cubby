import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense, importRun, photoGroupProposal } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { linkPhotoGroupExpense } from "./expense-link";

describe("photo review Expense link", () => {
  const ctx = withTestDb();

  it("links only a live, unlinked item line to the approved Product without changing money or quantity", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reviewer",
      kind: "member" as const,
      userId: ctx.actor.userId,
    });
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Canvas work boots" }),
      ctx.actor,
    );
    const runId = parseEntityId("importRun", crypto.randomUUID());
    const [run] = await getDb(ctx.db)
      .insert(importRun)
      .values({
        id: runId,
        shortcode: generateShortcode("importRun"),
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Synthetic reviewer",
        actorEmail: "review@example.com",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        agentSessionId: `photo-link-test:${runId}`,
        purpose: "photo_inventory",
        trigger: "manual",
        status: "completed",
      })
      .returning();
    await getDb(ctx.db).insert(photoGroupProposal).values({
      runId,
      groupKey: "boots",
      state: "committed",
      productKind: "existing",
      productId: product.entityId,
    });
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Canvas work boots size 7",
      date: "2026-01-05",
      cost: 120,
      costType: "materials",
      productQuantity: null,
      lineKind: "principal",
      lineBasis: "item_line",
      trade: "other",
    });

    await linkPhotoGroupExpense(
      ctx.db,
      {
        runId: run!.shortcode,
        groupKey: "boots",
        expenseId: line.shortcode,
      },
      ctx.actor,
    );
    const [after] = await getDb(ctx.db)
      .select({
        productId: expense.productId,
        cost: expense.cost,
        productQuantity: expense.productQuantity,
      })
      .from(expense)
      .where(eq(expense.id, line.id));
    expect(after).toEqual({
      productId: product.entityId,
      cost: 120,
      productQuantity: null,
    });
    await expect(
      linkPhotoGroupExpense(
        ctx.db,
        {
          runId: run!.shortcode,
          groupKey: "boots",
          expenseId: line.shortcode,
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/unlinked/i);
  });
});
