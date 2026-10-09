import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  run as runTable,
  runEvidence,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { researchWorklistFixture } from "./research-worklist.fixtures";
import { controlRun, startOrResumeRun } from "./run-service";
const HOST = "shop.example.test";
const INCREMENTAL_CURSOR = {
  newestOrderAt: "2026-09-15T00:00:00.000Z",
  orderIdsOnNewestDate: ["synthetic-existing-order"],
  backfillBeforeOrderAt: null,
  earliestAvailableOrderAt: null,
};
describe("explicit historical order backfill", () => {
  const ctx = withTestDb();
  async function seedAccount() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Backfill member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Backfill vendor ${crypto.randomUUID()}`,
      website: `https://${HOST}/orders`,
      browserDomains: [HOST],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Backfill account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      cursor: vendorAccountCursor.parse(INCREMENTAL_CURSOR),
    });
    return { party, vendor, account };
  }

  it("keeps backfill range isolated from the incremental cursor and never advances it on exhaustion", async () => {
    const { party, account } = await seedAccount();
    const range = { from: "2026-06-01", to: "2026-07-31" };
    const scope = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: range,
    });
    const research = researchWorklistFixture(ctx.db, scope.id);
    const work = await research.assigned();
    expect(work).toMatchObject({
      kind: "account_history",
      range,
      cursor: INCREMENTAL_CURSOR,
    });
    const observation = await research.retain(
      work.workRef,
      "<main>All pages for June through July were examined. There are no orders in that range.</main>",
    );
    await research.resolve(work.workRef, {
      status: "verified",
      evidenceIds: [observation.evidenceId],
      scopeExhausted: true,
    });
    expect(await research.next()).toMatchObject({
      status: "done",
      summary: { unresolved: 0 },
    });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(vendorAccount)
      .where(eq(vendorAccount.id, account.id));
    expect(stored?.cursor).toEqual(INCREMENTAL_CURSOR);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("refuses a backfill while another run holds the account and resumes the same range", async () => {
    const { party, account } = await seedAccount();
    const incremental = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "backfill",
        backfill: { from: "2026-01-01", to: "2026-03-31" },
      }),
    ).rejects.toThrow("already has an active import run");

    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.id, incremental.id));
    const range = { from: "2026-01-01", to: "2026-03-31" };
    const backfill = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: range,
    });
    const again = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: range,
    });
    expect(again).toMatchObject({ id: backfill.id, created: false });
    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: party.id,
        vendorAccountId: account.id,
        trigger: "backfill",
        backfill: { from: "2025-01-01", to: "2025-03-31" },
      }),
    ).rejects.toThrow("already has an active import run");
  });

  it("retains an unreadable backfill as replay-safe review work without inventing expenses", async () => {
    const { party, account } = await seedAccount();
    const scope = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: { from: "2026-06-01", to: "2026-07-31" },
    });
    const research = researchWorklistFixture(ctx.db, scope.id);
    const work = await research.assigned();
    const observation = await research.retain(
      work.workRef,
      "<main>Order SYNTHETIC-UNREADABLE June 2, 2026. Detail has no itemization or amount.</main>",
    );
    const input = {
      status: "researched_with_gaps",
      evidenceIds: [observation.evidenceId],
      gaps: ["Order detail has no line items or supported amount."],
      callId: "synthetic-unreadable-backfill",
    } as const;
    const first = await research.resolve(work.workRef, {
      ...input,
      evidenceIds: [...input.evidenceIds],
      gaps: [...input.gaps],
    });
    expect(
      await research.resolve(work.workRef, {
        ...input,
        evidenceIds: [...input.evidenceIds],
        gaps: [...input.gaps],
      }),
    ).toEqual(first);
    expect(await research.next()).toMatchObject({
      status: "done",
      summary: { unresolved: 1 },
    });
    const [stored] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, scope.id));
    expect(stored?.status).toBe("needs_review");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("restarts interrupted backfill with its frozen range and preserves retained originals", async () => {
    const { party, account } = await seedAccount();
    const range = { from: "2026-06-01", to: "2026-07-31" };
    const scope = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: range,
    });
    const research = researchWorklistFixture(ctx.db, scope.id);
    const work = await research.assigned();
    const observation = await research.retain(
      work.workRef,
      '<main><a href="/orders/synthetic-detail">SYNTHETIC-OPEN July 8, 2026</a><a href="/orders?page=2">Next page</a></main>',
    );
    const [original] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, observation.evidenceId));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, scope.id));
    const [publicScope] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, scope.id));
    if (!publicScope) throw new Error("Synthetic interrupted Run missing");
    const restarted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: publicScope.shortcode,
      action: "restart",
    });
    if (!("successorRunId" in restarted) || !restarted.successorRunId)
      throw new Error("Synthetic backfill successor missing");
    const next = await researchWorklistFixture(
      ctx.db,
      restarted.successorRunId,
    ).assigned();
    expect(next).toMatchObject({
      kind: "account_history",
      range,
      cursor: INCREMENTAL_CURSOR,
    });
    expect(next.workRef).not.toBe(work.workRef);
    const [retained] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, observation.evidenceId));
    expect(retained).toEqual(original);
    const [stored] = await getDb(ctx.db)
      .select()
      .from(vendorAccount)
      .where(eq(vendorAccount.id, account.id));
    expect(stored?.cursor).toEqual(INCREMENTAL_CURSOR);
  });
});
