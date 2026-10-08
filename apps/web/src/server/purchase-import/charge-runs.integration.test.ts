/**
 * Selected-charge admission refuses unsupported or foreign work atomically,
 * serializes account ownership, survives stop/offline/failure/re-match, and
 * keeps financial reconciliation separate from account-history cursors.
 * Outcome/replay and late-allocation behavior is exercised by the real
 * research scenario in purchase-agent-scenarios.integration.test.ts.
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
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  financialTransactionAllocation,
  importHunt,
  merchantVendorRule,
  run as runTable,
  runTarget,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { listChargeHunts, startSelectedChargeRun } from "./charge-runs";
import {
  discoverImportHunts,
  dispatchImportHunts,
  MAIL_GRACE_MS,
} from "./hunts";
import { researchWorklistFixture } from "./research-worklist.fixtures";
import {
  controlRun,
  expireOfflineRuns,
  markRunFailed,
  startOrResumeRun,
  stopRunForReview,
} from "./run-service";

describe("selected statement-charge runs", () => {
  const ctx = withTestDb();

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

    const objectives = researchObjectivesRunInput.parse(
      started.run.input,
    ).objectives;
    expect(objectives.map((objective) => objective.kind)).toEqual([
      "charge_hunt",
      "charge_hunt",
    ]);
    expect(
      objectives.flatMap((objective) =>
        objective.kind === "charge_hunt" ? [objective.huntId] : [],
      ),
    ).toEqual([
      (await huntOf(s.a.shortcode)).id,
      (await huntOf(s.b.shortcode)).id,
    ]);
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

    const work = await researchWorklistFixture(
      ctx.db,
      started.run.id,
    ).assigned();
    expect(work).toMatchObject({ kind: "charge_hunt" });
    expect([
      (await huntOf(s.a.shortcode)).id,
      (await huntOf(s.b.shortcode)).id,
    ]).toContain(work.huntRef);
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
    const research = researchWorklistFixture(ctx.db, started.run.id);
    const work = await research.assigned();
    expect(await research.next()).toMatchObject({ status: "working" });
    await research.resolve(work.workRef, { status: "verified" });
    expect(await research.next()).toMatchObject({
      status: "done",
      summary: { unresolved: 0 },
    });
    const [completed] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, started.run.id));
    expect(completed?.status).toBe("completed");
    const [account] = await getDb(ctx.db)
      .select({ cursor: vendorAccount.cursor })
      .from(vendorAccount)
      .where(eq(vendorAccount.id, s.account.id));
    expect(account?.cursor).toEqual(cursor);
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
    const research = researchWorklistFixture(ctx.db, started.run.id);
    const work = await research.assigned();
    await research.resolve(work.workRef, { status: "verified" });
    expect(await research.next()).toMatchObject({
      status: "done",
      summary: { unresolved: 0 },
    });
    expect((await huntOf(s.c.shortcode)).state).toBe("browser_queued");
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
      failureCode: "agent_failed",
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

    // Another unfinished Run owns hunt A. The successor must own only B;
    // a preserved Hunt outcome is separate from its newly admitted task.
    const a = await huntOf(s.a.shortcode);
    const { id: _id, shortcode: _shortcode, ...template } = first.run;
    await insertWithShortcode(ctx.db, "run", {
      ...template,
      status: "needs_review",
      clientKey: null,
      dispatchEventId: null,
      agentSessionId: null,
      predecessorRunId: null,
      input: researchObjectivesRunInput.parse({
        kind: "research_objectives",
        instructionRevision: 1,
        objectives: researchObjectivesRunInput
          .parse(first.run.input)
          .objectives.filter(
            (objective) =>
              objective.kind === "charge_hunt" && objective.huntId === a.id,
          ),
      }),
    });
    const restarted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: first.runId,
      action: "restart",
    });
    if (!("successorRunId" in restarted) || !restarted.successorRunId)
      throw new Error("Synthetic selected-charge successor missing");
    const [successor] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, restarted.successorRunId));
    if (!successor) throw new Error("Synthetic selected-charge Run missing");
    const b = await huntOf(s.b.shortcode);
    expect(
      researchObjectivesRunInput
        .parse(successor.input)
        .objectives.flatMap((objective) =>
          objective.kind === "charge_hunt" ? [objective.huntId] : [],
        ),
    ).toEqual([b.id]);
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, successor.id));
    expect(targets).toMatchObject([
      {
        sourceExternalKey: b.id,
        entityKind: "run",
        entityId: successor.id,
        state: "pending",
      },
    ]);
    expect(targets).toHaveLength(1);
    expect(
      await researchWorklistFixture(ctx.db, successor.id).next(),
    ).toMatchObject({
      status: "working",
      work: { kind: "charge_hunt", huntRef: b.id },
    });
    expect((await huntOf(s.a.shortcode)).state).toBe("deferred_for_review");
    expect((await huntOf(s.b.shortcode)).state).toBe("deferred_for_review");
    const listed = await listChargeHunts(
      ctx.db,
      vendorChargeHuntsInput.parse({ vendorAccountId: s.account.shortcode }),
      ctx.actor,
    );
    expect(
      listed.items.find((item) => item.transactionId === s.b.shortcode),
    ).toMatchObject({ runId: successor.shortcode });
  });

  it("treats a dispatch_failed charge run as holding its hunts against implicit starts, restarts, and retries", async () => {
    const s = await threeCharges();
    // A finished account-history Run remains independently restartable.
    const implicit = await startOrResumeRun(ctx.db, {
      ledgerPartyId: s.party.id,
      vendorAccountId: s.account.id,
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.id, implicit.id));
    const [implicitRow] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, implicit.id));
    const charge = await start(s, [s.a]);
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "dispatch_failed" })
      .where(eq(runTable.id, charge.run.id));

    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "dispatch_failed" })
      .where(eq(runTable.id, implicit.id));
    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: s.party.id,
        vendorAccountId: s.account.id,
        trigger: "manual",
      }),
    ).rejects.toThrow("charge search");
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: implicitRow!.shortcode,
        action: "retry_dispatch",
      }),
    ).rejects.toThrow("charge search");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, implicit.id));
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: implicitRow!.shortcode,
        action: "restart",
      }),
    ).rejects.toThrow("Objective account has newer active research.");
  });

  it("refuses to restart a charge run that has nothing left to carry", async () => {
    const s = await threeCharges();
    const started = await start(s, [s.a]);
    await allocate(s, s.a);
    const research = researchWorklistFixture(ctx.db, started.run.id);
    const work = await research.assigned();
    await research.resolve(work.workRef, { status: "verified" });
    expect(await research.next()).toMatchObject({ status: "done" });
    const before = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.vendorAccountId, s.account.id));
    const beforeHunt = await huntOf(s.a.shortcode);
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: started.runId,
        action: "restart",
      }),
    ).rejects.toThrow(/objectives/);
    const after = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.vendorAccountId, s.account.id));
    expect(after).toEqual(before);
    expect(
      after.filter((scope) => scope.predecessorRunId === started.run.id),
    ).toEqual([]);
    expect(await huntOf(s.a.shortcode)).toEqual(beforeHunt);
    expect(beforeHunt.state).toBe("resolved");
  });

  it("dispatches re-matched charges as owned research after their selected run parked in review", async () => {
    const s = await threeCharges();
    const first = await start(s, [s.a]);
    await stopRunForReview(ctx.db, {
      runId: first.run.id,
      operationId: "stop:parked",
      kind: "other",
      summary: "Parked.",
    });
    const a = await huntOf(s.a.shortcode);
    expect(a.state).toBe("deferred_for_review");
    // New order mail re-matches the deferred charge.
    await getDb(ctx.db)
      .update(importHunt)
      .set({ state: "pending_browser", matchedOrderIds: ["ORDER-1"] })
      .where(eq(importHunt.id, a.id));
    // It is selectable again, not "Needs review" on the parked run.
    const listed = await listChargeHunts(
      ctx.db,
      vendorChargeHuntsInput.parse({ vendorAccountId: s.account.shortcode }),
      ctx.actor,
    );
    expect(
      listed.items.find((item) => item.transactionId === s.a.shortcode),
    ).toMatchObject({ reason: null, runId: null });

    await expect(dispatchImportHunts(ctx.db, queue().producer)).resolves.toBe(
      1,
    );
    const scopes = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.vendorAccountId, s.account.id));
    const dispatched = scopes.find((scope) => scope.id !== first.run.id);
    if (!dispatched) throw new Error("Synthetic dispatched charge Run missing");
    const research = researchWorklistFixture(ctx.db, dispatched.id);
    expect(await research.next()).toMatchObject({
      status: "working",
      work: { kind: "charge_hunt", huntRef: a.id },
    });
    expect(await research.next()).toMatchObject({ status: "working" });
    await expect(
      startOrResumeRun(ctx.db, {
        ledgerPartyId: s.party.id,
        vendorAccountId: s.account.id,
        trigger: "discovery",
      }),
    ).rejects.toThrow("charge search");
  });
});
