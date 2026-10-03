import type { BrowserBridgeResult } from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  run as runTable,
  runFinding,
  runOrderCandidate,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { fakeBroker, historyPage, HOST } from "./order-history.fixtures";
import {
  claimNextImportWork,
  controlRun,
  deferOrderForReview,
  finishRun,
  importBrowserOrderEvidence,
  issueBrowserCommand,
  startOrResumeRun,
} from "./run-service";

const INCREMENTAL_CURSOR = {
  newestOrderAt: "2026-09-15T00:00:00.000Z",
  orderIdsOnNewestDate: ["111-0000000-0000001"],
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

  async function listPage(
    runId: string,
    operationId: string,
    outcome: BrowserBridgeResult["outcome"],
  ) {
    const bridge = fakeBroker();
    const issued = await issueBrowserCommand(ctx.db, bridge.namespace, {
      runId,
      operationId,
      operation: {
        type: "navigate",
        url: `https://${HOST}/order-history`,
        allowedHosts: [HOST],
      },
    });
    bridge.respondWith(outcome);
    return importBrowserOrderEvidence(ctx.db, bridge.namespace, {
      runId,
      operationId: `${operationId}:import`,
      commandId: issued.commandId,
    });
  }

  async function candidates(runId: string) {
    return (
      await getDb(ctx.db)
        .select({
          orderId: runOrderCandidate.orderId,
          state: runOrderCandidate.state,
        })
        .from(runOrderCandidate)
        .where(eq(runOrderCandidate.runId, runId))
    ).sort((a, b) => a.orderId.localeCompare(b.orderId));
  }

  it("walks past the incremental cursor, keeps only in-range orders, and never moves the cursor", async () => {
    const { party, account } = await seedAccount();
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: { from: "2026-06-01", to: "2026-07-31" },
    });
    const [stored] = await getDb(ctx.db)
      .select({ trigger: runTable.trigger, input: runTable.input })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(stored).toEqual({
      trigger: "backfill",
      input: { kind: "order_backfill", from: "2026-06-01", to: "2026-07-31" },
    });

    // A page entirely older than the incremental cursor would end an
    // incremental walk; a backfill keeps paging until it passes `from`.
    const first = await listPage(
      run.id,
      "walk:1",
      historyPage(
        [
          { id: "111-1000000-0000008", date: "August 3, 2026" },
          { id: "111-1000000-0000007", date: "July 20, 2026" },
          { id: "111-1000000-0000006", date: "July 20, 2026" },
        ],
        `https://${HOST}/order-history?startIndex=10`,
      ),
    );
    expect(first).toMatchObject({
      kind: "order_list",
      pending: 2,
      nextPageUrl: `https://${HOST}/order-history?startIndex=10`,
    });
    const second = await listPage(
      run.id,
      "walk:2",
      historyPage(
        [
          { id: "111-1000000-0000005", date: "June 2, 2026" },
          { id: "111-1000000-0000004", date: "May 28, 2026" },
        ],
        `https://${HOST}/order-history?startIndex=20`,
      ),
    );
    // Pages are newest first, but only a page entirely older than `from`
    // proves nothing in range remains, as with the incremental cursor.
    expect(second).toMatchObject({
      kind: "order_list",
      nextPageUrl: `https://${HOST}/order-history?startIndex=20`,
    });
    const third = await listPage(
      run.id,
      "walk:3",
      historyPage(
        [{ id: "111-1000000-0000003", date: "May 10, 2026" }],
        `https://${HOST}/order-history?startIndex=30`,
      ),
    );
    expect(third).toMatchObject({ kind: "order_list", nextPageUrl: null });
    expect(await candidates(run.id)).toEqual([
      { orderId: "111-1000000-0000005", state: "pending" },
      { orderId: "111-1000000-0000006", state: "pending" },
      { orderId: "111-1000000-0000007", state: "pending" },
    ]);

    await getDb(ctx.db)
      .update(runOrderCandidate)
      .set({ state: "imported" })
      .where(eq(runOrderCandidate.runId, run.id));
    await finishRun(ctx.db, fakeBroker().namespace, {
      runId: run.id,
      operationId: "finish:backfill",
    });
    const [after] = await getDb(ctx.db)
      .select({ cursor: vendorAccount.cursor })
      .from(vendorAccount)
      .where(eq(vendorAccount.id, account.id));
    expect(vendorAccountCursor.parse(after?.cursor)).toEqual(
      INCREMENTAL_CURSOR,
    );
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

  it("defers one unreadable order for review while the rest of the run continues and finishes", async () => {
    const { party, account } = await seedAccount();
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: { from: "2026-06-01", to: "2026-07-31" },
    });
    await listPage(
      run.id,
      "walk:1",
      historyPage(
        [
          { id: "111-2000000-0000002", date: "July 2, 2026" },
          { id: "111-2000000-0000001", date: "June 2, 2026" },
        ],
        null,
      ),
    );

    const deferred = await deferOrderForReview(ctx.db, {
      runId: run.id,
      operationId: "defer:111-2000000-0000002",
      orderId: "111-2000000-0000002",
      summary: "Order detail page rendered without line items twice.",
    });
    expect(
      await deferOrderForReview(ctx.db, {
        runId: run.id,
        operationId: "defer:111-2000000-0000002",
        orderId: "111-2000000-0000002",
        summary: "Order detail page rendered without line items twice.",
      }),
    ).toEqual(deferred);
    await expect(
      deferOrderForReview(ctx.db, {
        runId: run.id,
        operationId: "defer:unknown",
        orderId: "111-9999999-9999999",
        summary: "Not on the worklist.",
      }),
    ).rejects.toThrow("not a pending order");

    // The other order is still the next work item.
    await expect(
      claimNextImportWork(ctx.db, fakeBroker().namespace, run.id),
    ).resolves.toMatchObject({
      kind: "order",
      orderId: "111-2000000-0000001",
    });
    await getDb(ctx.db)
      .update(runOrderCandidate)
      .set({ state: "imported" })
      .where(
        and(
          eq(runOrderCandidate.runId, run.id),
          eq(runOrderCandidate.orderId, "111-2000000-0000001"),
        ),
      );
    const finished = await finishRun(ctx.db, fakeBroker().namespace, {
      runId: run.id,
      operationId: "finish:with-deferred",
    });
    // A deferred order is not a completed import: the run ends in review.
    expect(finished).toMatchObject({
      status: "needs_review",
      findingCount: 1,
    });
    expect(await candidates(run.id)).toEqual([
      { orderId: "111-2000000-0000001", state: "imported" },
      { orderId: "111-2000000-0000002", state: "skipped" },
    ]);
    const findings = await getDb(ctx.db)
      .select({ summary: runFinding.summary, status: runFinding.status })
      .from(runFinding)
      .where(eq(runFinding.runId, run.id));
    expect(findings).toEqual([
      {
        summary: expect.stringContaining("111-2000000-0000002"),
        status: "open",
      },
    ]);
  });

  it("restarts an interrupted backfill from its history page with its unfinished orders", async () => {
    const { party, account } = await seedAccount();
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: { from: "2026-06-01", to: "2026-07-31" },
    });
    await listPage(
      run.id,
      "walk:1",
      historyPage(
        [
          { id: "111-3000000-0000002", date: "July 9, 2026" },
          { id: "111-3000000-0000001", date: "July 8, 2026" },
        ],
        `https://${HOST}/order-history?startIndex=10`,
      ),
    );
    await getDb(ctx.db)
      .update(runOrderCandidate)
      .set({ state: "imported" })
      .where(
        and(
          eq(runOrderCandidate.runId, run.id),
          eq(runOrderCandidate.orderId, "111-3000000-0000002"),
        ),
      );
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, run.id));
    const [publicRun] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, run.id));

    const restarted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: publicRun!.shortcode,
      action: "restart",
    });
    const successorId = restarted.successorRunId!;
    const [successor] = await getDb(ctx.db)
      .select({
        trigger: runTable.trigger,
        input: runTable.input,
        historyCursorUrl: runTable.historyCursorUrl,
      })
      .from(runTable)
      .where(eq(runTable.id, successorId));
    expect(successor).toEqual({
      trigger: "backfill",
      input: { kind: "order_backfill", from: "2026-06-01", to: "2026-07-31" },
      historyCursorUrl: `https://${HOST}/order-history?startIndex=10`,
    });
    expect(await candidates(successorId)).toEqual([
      { orderId: "111-3000000-0000001", state: "pending" },
    ]);
  });
});
