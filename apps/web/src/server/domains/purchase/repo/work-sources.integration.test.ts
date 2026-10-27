import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/domains/work/service/work-queue-read";
import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { publishAllQualityFixtures } from "~/server/testing/quality.fixtures";

// Keep financial facts and posting grace exercised through real domain sources;
// engine permutations belong to the synthetic-source suite.
describe("financial Work sources", () => {
  const ctx = withTestDb();
  const read = (reason: string) =>
    readWorkQueue(ctx.db, {
      input: { reason, pageSize: 100 },
      memberPartyId: null,
      memberOnly: false,
    });

  it("sums live costs including credits and defers planned purchases before counts", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Work facts vendor",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
      displayLabel: "Synthetic Work facts order",
    });
    const line = async (cost: number) =>
      insertWithShortcode(ctx.db, "expense", {
        purchaseId: order.id,
        name: "Synthetic Work facts line",
        costType: "materials",
        cost,
        date: "2026-09-01",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      });
    await line(30);
    await line(-7);
    const deleted = await line(100);
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, deleted.id));
    const empty = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const planned = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2999-01-01",
    });
    const plannedLines = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: plannedLines.id,
      name: "Synthetic planned Work line",
      costType: "materials",
      cost: 20,
      date: "2026-09-01",
      future: true,
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    await publishAllQualityFixtures(ctx.db);
    expect(
      (await read("reconciliation:purchase-unsettled")).items,
    ).toContainEqual(
      expect.objectContaining({
        id: order.shortcode,
        amount: 23,
        date: "2026-09-01",
        executor: "human",
      }),
    );
    for (const target of [order, empty])
      await publishFieldAssessment(
        ctx.db,
        {
          entity: "purchase",
          recordId: target.id,
          field: "notes",
          currentValue: null,
          suggestedValue: "Synthetic Work note",
          confidence: 0.9,
          model: "typesafe/jev",
          kind: "addition",
          status: "pending",
          createdAt: new Date(),
        },
        true,
      );
    const suggestions = await read("suggestions:field");
    expect(suggestions.items).toHaveLength(2);
    expect(
      suggestions.items.find((row) => row.id === order.shortcode),
    ).toMatchObject({ amount: 23, date: "2026-09-01" });
    expect(
      suggestions.items.find((row) => row.id === empty.shortcode)?.amount,
    ).toBeNull();
    const research = await read("purchase_vendor_account");
    expect(research.items.map((row) => row.id)).toContain(empty.shortcode);
    expect(research.items.map((row) => row.id)).not.toContain(
      planned.shortcode,
    );
    expect(research.items.map((row) => row.id)).not.toContain(
      plannedLines.shortcode,
    );
    expect(research.meta.totalCount).toBe(2);
    expect(
      (
        await readRecordWorkQueue(ctx.db, {
          id: planned.shortcode,
          memberPartyId: null,
          memberOnly: false,
        })
      ).items,
    ).toEqual([]);
  });

  it("routes transfer grace to external and declares the guided pairing action", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic transfer member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic transfer account",
      identity: { kind: "cash" },
      ledgerPartyId: member.shortcode,
    });
    const accountId = await resolveOrThrow(
      ctx.db,
      "financialAccount",
      account.output.id,
    );
    const transfer = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId,
      kind: "account_transfer",
      status: "posted",
      amount: -25,
      transactionDate: "2026-10-09",
      postedDate: "2026-10-09",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-10T18:00:00Z"));
      const waiting = await read("awaiting_posting:reconciliation:transfer");
      expect(waiting.items).toEqual([
        expect.objectContaining({
          id: transfer.shortcode,
          family: "reconciliation",
          executor: "external",
          amount: -25,
          owners: [expect.objectContaining({ id: member.shortcode })],
          actions: [
            {
              id: "pair-transfer",
              label: "Pair transfer",
              scope: "item",
              target: "guided-flow",
            },
          ],
        }),
      ]);
      vi.setSystemTime(new Date("2026-10-14T18:00:00Z"));
      expect(
        (await read("awaiting_posting:reconciliation:transfer")).meta
          .totalCount,
      ).toBe(0);
      expect((await read("reconciliation:transfer")).items).toEqual([
        expect.objectContaining({ id: transfer.shortcode, executor: "human" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
