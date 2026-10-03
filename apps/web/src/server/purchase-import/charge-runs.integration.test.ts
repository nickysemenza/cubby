/**
 * Selected statement-charge runs against real PostgreSQL.
 *
 * Failure modes these scenarios guard:
 * - a charge outside the member's selection (another hunt of the same
 *   account) joins the selected run, by a claim or by `dispatchImportHunts`;
 * - a selection that includes a settled charge, a receipt-photo hunt, a charge
 *   already on an unfinished run, another member's account, or a busy account
 *   is partly accepted instead of refused whole;
 * - finishing succeeds while a selected hunt has no recorded outcome, or reads
 *   as a complete import while one is deferred or not found;
 * - an agent outcome for a charge the server already settled overwrites the
 *   settlement, or an outcome for a charge outside the run is accepted;
 * - a stop or restart loses unresolved selected charges, or re-queues a
 *   resolved one;
 * - a charge search moves the account's order-history cursor.
 */
import type {
  FinancialAccountId,
  FinancialTransactionId,
  LedgerPartyId,
} from "@cubby/schemas/identifiers";
import {
  chargeRunStartInput,
  vendorChargeHuntsInput,
} from "@cubby/schemas/order-mail-review";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  financialTransactionAllocation,
  importHunt,
  merchantVendorRule,
  run as runTable,
  runOrderCandidate,
  runFinding,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { listChargeHunts, startSelectedChargeRun } from "./charge-runs";
import {
  discoverImportHunts,
  dispatchImportHunts,
  MAIL_GRACE_MS,
} from "./hunts";
import { fakeBroker } from "./order-history.fixtures";
import {
  claimNextImportWork,
  controlRun,
  expireOfflineRuns,
  markRunFailed,
  startOrResumeRun,
  finishRun,
  settleChargeHunt,
  stopRunForReview,
} from "./run-service";

describe("selected statement-charge runs", () => {
  const ctx = withTestDb();
  const broker = fakeBroker().namespace;

  let shops = 0;

  /** A routed Vendor account; pass `share` to add another shop for the same member and card. */
  async function seed(
    orderEvidence: "online_account" | "receipt_only" = "online_account",
    share?: { party: { id: LedgerPartyId }; card: { id: FinancialAccountId } },
  ) {
    shops += 1;
    const merchant = `charge shop ${shops}`;
    const party =
      share?.party ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Charge run member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    const card =
      share?.card ??
      (await insertWithShortcode(ctx.db, "financialAccount", {
        name: "Synthetic card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      }));
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Charge shop ${crypto.randomUUID()}`,
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
      orderEvidence,
    });
    await getDb(ctx.db).insert(merchantVendorRule).values({
      ledgerPartyId: party.id,
      normalizedMerchant: merchant,
      vendorId: vendor.id,
      confirmedByUserId: ctx.actor.userId,
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Charge account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const charge = (amount: number, date: string) =>
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: card.id,
        kind: "purchase",
        status: "posted",
        amount,
        merchant: merchant.toUpperCase(),
        transactionDate: date,
        postedDate: date,
      });
    return { party, card, vendor, account, charge };
  }

  const startInput = (
    account: { shortcode: string },
    charges: Array<{ shortcode: string }>,
  ) =>
    chargeRunStartInput.parse({
      vendorAccountId: account.shortcode,
      transactionIds: charges.map((charge) => charge.shortcode),
    });

  const huntOf = async (transactionShortcode: string) => {
    const { financialTransaction } = await import("~/server/db/schema");
    const [row] = await getDb(ctx.db)
      .select({ id: importHunt.id, state: importHunt.state })
      .from(importHunt)
      .innerJoin(
        financialTransaction,
        eq(financialTransaction.id, importHunt.financialTransactionId),
      )
      .where(eq(financialTransaction.shortcode, transactionShortcode));
    if (!row) throw new Error("test setup: charge has no hunt");
    return row;
  };

  const queue = () => {
    const sent: PurchaseAgentEvent[] = [];
    return {
      sent,
      producer: {
        send: async (event: PurchaseAgentEvent) => void sent.push(event),
      },
    };
  };

  async function threeCharges() {
    const s = await seed();
    const a = await s.charge(10, "2026-09-01");
    const b = await s.charge(20, "2026-09-02");
    const c = await s.charge(30, "2026-09-03");
    await discoverImportHunts(ctx.db);
    return { ...s, a, b, c };
  }

  async function start(
    s: Awaited<ReturnType<typeof threeCharges>>,
    charges: Array<{ shortcode: string }>,
  ) {
    const q = queue();
    const started = await startSelectedChargeRun(
      ctx.db,
      startInput(s.account, charges),
      ctx.actor,
      q.producer,
    );
    const [row] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, started.runId));
    if (!row) throw new Error("run missing");
    return { ...started, run: row, sent: q.sent };
  }

  async function allocate(
    s: Awaited<ReturnType<typeof threeCharges>>,
    charge: { id: FinancialTransactionId },
  ) {
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: s.vendor.id,
      vendorAccountId: s.account.id,
      date: "2026-09-01",
      displayLabel: "Settled order",
    });
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: charge.id,
      purchaseId: purchase.id,
      amount: 1,
    });
  }

  it("runs exactly the selected charges and keeps every other hunt out of the run", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a, s.b]);

    expect(started.run.input).toEqual({
      kind: "charge_hunts",
      huntIds: [
        (await huntOf(s.a.shortcode)).id,
        (await huntOf(s.b.shortcode)).id,
      ],
    });
    expect(started.run.trigger).toBe("manual");
    expect(started.sent.map((event) => event.type)).toEqual([
      "start_or_resume",
    ]);
    expect((await huntOf(s.a.shortcode)).state).toBe("browser_queued");
    expect((await huntOf(s.b.shortcode)).state).toBe("browser_queued");
    expect((await huntOf(s.c.shortcode)).state).toBe("pending_mail");

    // The implicit queue skips an account running selected charges, even once
    // the unselected hunt's mail grace window has passed.
    const implicit = queue();
    await expect(
      dispatchImportHunts(
        ctx.db,
        implicit.producer,
        new Date(Date.now() + MAIL_GRACE_MS + 60_000),
      ),
    ).resolves.toBe(0);
    expect(implicit.sent).toEqual([]);
    expect((await huntOf(s.c.shortcode)).state).toBe("pending_mail");

    // Claims follow the selection, oldest charge first, and never the rest.
    await expect(
      claimNextImportWork(ctx.db, broker, started.run.id),
    ).resolves.toMatchObject({
      kind: "hunt",
      id: (await huntOf(s.a.shortcode)).id,
    });
  });

  it("refuses a whole selection that includes anything unsearchable, changing nothing", async () => {
    const s = await threeCharges();
    await allocate(s, s.a);
    const receipt = await seed("receipt_only", s);
    const receiptCharge = await receipt.charge(40, "2026-09-04");
    await discoverImportHunts(ctx.db);
    expect((await huntOf(receiptCharge.shortcode)).state).toBe(
      "receipt_required",
    );

    const attempt = (
      account: { shortcode: string },
      charges: Array<{ shortcode: string }>,
    ) =>
      startSelectedChargeRun(
        ctx.db,
        startInput(account, charges),
        ctx.actor,
        queue().producer,
      );

    await expect(attempt(s.account, [s.b, s.a])).rejects.toThrow(
      "already settled",
    );
    await expect(attempt(receipt.account, [receiptCharge])).rejects.toThrow(
      "receipt photo",
    );
    // A charge of another account is not on this account's worklist.
    await expect(attempt(s.account, [s.b, receiptCharge])).rejects.toThrow(
      "no open search",
    );

    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other member",
      kind: "member",
    });
    const otherAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Other account",
      vendorId: s.vendor.id,
      ledgerPartyId: other.id,
    });
    await expect(attempt(otherAccount, [s.b])).rejects.toThrow(
      "not found for this member",
    );

    expect((await huntOf(s.b.shortcode)).state).toBe("pending_mail");
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.vendorAccountId, s.account.id)),
    ).toEqual([]);

    // A busy account refuses instead of folding the selection into its run.
    await start(s, [s.b]);
    await expect(attempt(s.account, [s.c])).rejects.toThrow(
      "already has an active import run",
    );
    expect((await huntOf(s.c.shortcode)).state).toBe("pending_mail");
    // And the same charge cannot start a second run.
    await expect(attempt(s.account, [s.b])).rejects.toThrow("Already on run");
  });

  it("admits one run when the same selection is started twice at once", async () => {
    const s = await threeCharges();
    const results = await Promise.allSettled([
      start(s, [s.a, s.b]),
      start(s, [s.a, s.b]),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      await getDb(ctx.db)
        .select({ id: runTable.id })
        .from(runTable)
        .where(eq(runTable.vendorAccountId, s.account.id)),
    ).toHaveLength(1);
  });

  it("lists each open charge with why it can or cannot be selected", async () => {
    const s = await threeCharges();
    await allocate(s, s.c);
    await start(s, [s.a]);
    const listed = await listChargeHunts(
      ctx.db,
      vendorChargeHuntsInput.parse({ vendorAccountId: s.account.shortcode }),
      ctx.actor,
    );
    expect(
      listed.items.map(({ transactionId, reason, outcome }) => ({
        transactionId,
        selectable: reason === null,
        outcome,
      })),
    ).toEqual([
      { transactionId: s.a.shortcode, selectable: false, outcome: "pending" },
      { transactionId: s.b.shortcode, selectable: true, outcome: null },
    ]);
  });

  it("records each charge's outcome, gates finishing on pending ones, and ends in review", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a, s.b, s.c]);
    const runId = started.run.id;
    const [a, b, c] = [
      await huntOf(s.a.shortcode),
      await huntOf(s.b.shortcode),
      await huntOf(s.c.shortcode),
    ];

    await expect(
      finishRun(ctx.db, broker, { runId, operationId: "finish:early" }),
    ).rejects.toThrow("unsettled browser hunt work");

    await expect(
      claimNextImportWork(ctx.db, broker, runId),
    ).resolves.toMatchObject({ kind: "hunt", id: a.id });
    await expect(
      settleChargeHunt(ctx.db, {
        runId,
        operationId: "settle:a",
        huntId: a.id,
        outcome: "not_found",
        summary: "No order near this amount in the last month.",
      }),
    ).resolves.toEqual({ huntId: a.id, outcome: "not_found" });
    // Replay-safe.
    await expect(
      settleChargeHunt(ctx.db, {
        runId,
        operationId: "settle:a",
        huntId: a.id,
        outcome: "not_found",
        summary: "No order near this amount in the last month.",
      }),
    ).resolves.toEqual({ huntId: a.id, outcome: "not_found" });

    await expect(
      claimNextImportWork(ctx.db, broker, runId),
    ).resolves.toMatchObject({ kind: "hunt", id: b.id });
    await settleChargeHunt(ctx.db, {
      runId,
      operationId: "settle:b",
      huntId: b.id,
      outcome: "needs_review",
      summary: "Two orders fit this amount and date.",
    });

    await expect(
      claimNextImportWork(ctx.db, broker, runId),
    ).resolves.toMatchObject({ kind: "hunt", id: c.id });
    // The server settles this charge while the agent is still on it.
    await allocate(s, s.c);
    await expect(
      settleChargeHunt(ctx.db, {
        runId,
        operationId: "settle:c",
        huntId: c.id,
        outcome: "not_found",
        summary: "Stale agent claim.",
      }),
    ).resolves.toEqual({ huntId: c.id, outcome: "resolved" });
    // An outcome for a hunt outside the run is refused.
    const outsider = await seed("online_account", s);
    const stray = await outsider.charge(99, "2026-09-05");
    await discoverImportHunts(ctx.db);
    await expect(
      settleChargeHunt(ctx.db, {
        runId,
        operationId: "settle:stray",
        huntId: (await huntOf(stray.shortcode)).id,
        outcome: "not_found",
        summary: "Not mine.",
      }),
    ).rejects.toThrow("is not on this run");

    await expect(
      claimNextImportWork(ctx.db, broker, runId),
    ).resolves.toMatchObject({ kind: "none" });
    const finished = await finishRun(ctx.db, broker, {
      runId,
      operationId: "finish:review",
    });
    // A deferred or missing charge is not a complete import.
    expect(finished).toMatchObject({ status: "needs_review", findingCount: 1 });
    const progress = await getRunLiveProgress(ctx.db, started.runId);
    expect(progress?.charges).toEqual([
      { chargeId: s.a.shortcode, outcome: "not_found" },
      { chargeId: s.b.shortcode, outcome: "deferred" },
      { chargeId: s.c.shortcode, outcome: "resolved" },
    ]);
    const findings = await getDb(ctx.db)
      .select({ summary: runFinding.summary })
      .from(runFinding)
      .where(eq(runFinding.runId, runId));
    expect(findings).toEqual([
      { summary: expect.stringContaining(s.b.shortcode) },
    ]);
  });

  it("completes only when every selected charge settles, without moving the account cursor", async () => {
    const s = await threeCharges();
    const cursor = vendorAccountCursor.parse({
      newestOrderAt: "2026-09-15T00:00:00.000Z",
      orderIdsOnNewestDate: ["order-1"],
      backfillBeforeOrderAt: null,
      earliestAvailableOrderAt: null,
    });
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ cursor })
      .where(eq(vendorAccount.id, s.account.id));
    const started = await start(s, [s.a]);
    await allocate(s, s.a);
    await expect(
      finishRun(ctx.db, broker, {
        runId: started.run.id,
        operationId: "finish:ok",
      }),
    ).resolves.toMatchObject({ status: "completed", findingCount: 0 });
    const [account] = await getDb(ctx.db)
      .select({ cursor: vendorAccount.cursor })
      .from(vendorAccount)
      .where(eq(vendorAccount.id, s.account.id));
    expect(account?.cursor).toEqual(cursor);
  });

  it("carries unresolved selected charges into a restart and keeps resolved ones", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a, s.b, s.c]);
    const runId = started.run.id;
    const [a, b] = [await huntOf(s.a.shortcode), await huntOf(s.b.shortcode)];
    await settleChargeHunt(ctx.db, {
      runId,
      operationId: "s:a",
      huntId: a.id,
      outcome: "not_found",
      summary: "Nothing found.",
    });
    await settleChargeHunt(ctx.db, {
      runId,
      operationId: "s:b",
      huntId: b.id,
      outcome: "needs_review",
      summary: "Ambiguous.",
    });
    await allocate(s, s.c);
    await finishRun(ctx.db, broker, { runId, operationId: "finish:review" });

    // The unfinished run still owns its charges.
    await expect(
      startSelectedChargeRun(
        ctx.db,
        startInput(s.account, [s.a]),
        ctx.actor,
        queue().producer,
      ),
    ).rejects.toThrow("Already on run");

    const restarted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: started.runId,
      action: "restart",
    });
    const [successor] = await getDb(ctx.db)
      .select({ input: runTable.input })
      .from(runTable)
      .where(eq(runTable.id, restarted.successorRunId!));
    expect(successor?.input).toEqual(started.run.input);
    expect((await huntOf(s.a.shortcode)).state).toBe("browser_queued");
    expect((await huntOf(s.b.shortcode)).state).toBe("browser_queued");
    expect((await huntOf(s.c.shortcode)).state).toBe("resolved");
    await expect(
      claimNextImportWork(ctx.db, broker, restarted.successorRunId!),
    ).resolves.toMatchObject({ kind: "hunt", id: a.id });
  });

  it("leaves unfinished selected charges for review when the run is stopped", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a, s.b]);
    await stopRunForReview(ctx.db, {
      runId: started.run.id,
      operationId: "stop:1",
      kind: "other",
      summary: "The vendor site would not load.",
    });
    expect((await huntOf(s.a.shortcode)).state).toBe("deferred_for_review");
    expect((await huntOf(s.b.shortcode)).state).toBe("deferred_for_review");
    expect((await huntOf(s.c.shortcode)).state).toBe("pending_mail");
  });

  it("finishes a charge run even when an unselected hunt is queued on the same account", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a]);
    // An orphan queued hunt (unselected) must not gate this run.
    await getDb(ctx.db)
      .update(importHunt)
      .set({ state: "browser_queued" })
      .where(eq(importHunt.id, (await huntOf(s.c.shortcode)).id));
    await allocate(s, s.a);
    await expect(
      finishRun(ctx.db, broker, {
        runId: started.run.id,
        operationId: "finish:orphan",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("leaves selected charges reselectable when the run is cancelled, fails, or expires offline", async () => {
    const s = await threeCharges();
    const cancelled = await start(s, [s.a]);
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: cancelled.runId,
      action: "cancel",
    });
    expect((await huntOf(s.a.shortcode)).state).toBe("deferred_for_review");

    const failed = await start(s, [s.a]);
    await markRunFailed(ctx.db, {
      runId: failed.run.id,
      failureCode: "flue_failed",
    });
    expect((await huntOf(s.a.shortcode)).state).toBe("deferred_for_review");

    const offline = await start(s, [s.a]);
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_offline", updatedAt: new Date(0) })
      .where(eq(runTable.id, offline.run.id));
    await expireOfflineRuns(ctx.db);
    expect((await huntOf(s.a.shortcode)).state).toBe("deferred_for_review");

    // And the list says it can be selected again.
    const listed = await listChargeHunts(
      ctx.db,
      vendorChargeHuntsInput.parse({ vendorAccountId: s.account.shortcode }),
      ctx.actor,
    );
    expect(
      listed.items.find((item) => item.transactionId === s.a.shortcode)?.reason,
    ).toBeNull();
  });

  it("never lets an implicit start join an active charge run", async () => {
    const s = await threeCharges();
    await start(s, [s.a]);
    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: s.party.id,
        vendorAccountId: s.account.id,
        trigger: "manual",
      }),
    ).rejects.toThrow("charge search");
    // The implicit dispatcher skips the account instead of throwing.
    await getDb(ctx.db)
      .update(importHunt)
      .set({ state: "pending_browser" })
      .where(eq(importHunt.id, (await huntOf(s.c.shortcode)).id));
    await expect(dispatchImportHunts(ctx.db, queue().producer)).resolves.toBe(
      0,
    );
    expect((await huntOf(s.c.shortcode)).state).toBe("pending_browser");
  });

  it("refuses to restart a charge run onto a busy account and skips hunts another unfinished run owns", async () => {
    const s = await threeCharges();
    const first = await start(s, [s.a, s.b]);
    await stopRunForReview(ctx.db, {
      runId: first.run.id,
      operationId: "stop:r1",
      kind: "other",
      summary: "Site down.",
    });
    const busy = await startOrResumeRun(ctx.db, {
      ledgerPartyId: s.party.id,
      vendorAccountId: s.account.id,
      trigger: "manual",
    });
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: first.runId,
        action: "restart",
      }),
    ).rejects.toThrow("active");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, busy.id));

    // Another unfinished charge run owns hunt A: a restart of the first run
    // re-queues only B.
    const a = await huntOf(s.a.shortcode);
    const { id: _id, shortcode: _shortcode, ...template } = first.run;
    await insertWithShortcode(ctx.db, "run", {
      ...template,
      status: "needs_review",
      clientKey: null,
      dispatchEventId: null,
      agentSessionId: null,
      predecessorRunId: null,
      input: { kind: "charge_hunts", huntIds: [a.id] },
    });
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: first.runId,
      action: "restart",
    });
    expect((await huntOf(s.a.shortcode)).state).toBe("deferred_for_review");
    expect((await huntOf(s.b.shortcode)).state).toBe("browser_queued");
  });

  it("does not exhaust a charge run's queued hunts when an implicit run stops", async () => {
    const s = await threeCharges();
    const first = await start(s, [s.a]);
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review" })
      .where(eq(runTable.id, first.run.id));
    const implicit = await startOrResumeRun(ctx.db, {
      ledgerPartyId: s.party.id,
      vendorAccountId: s.account.id,
      trigger: "manual",
    });
    await stopRunForReview(ctx.db, {
      runId: implicit.id,
      operationId: "stop:implicit",
      kind: "other",
      summary: "Implicit run stopped.",
    });
    expect((await huntOf(s.a.shortcode)).state).toBe("browser_queued");
  });

  it("ends in review when a deferred order candidate sits on an otherwise settled charge run", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a]);
    await getDb(ctx.db).insert(runOrderCandidate).values({
      runId: started.run.id,
      orderId: "ORDER-SKIPPED",
      state: "skipped",
    });
    await allocate(s, s.a);
    await expect(
      finishRun(ctx.db, broker, {
        runId: started.run.id,
        operationId: "finish:skipped",
      }),
    ).resolves.toMatchObject({ status: "needs_review" });
  });
});
