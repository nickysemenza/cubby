import type { EntityId } from "@cubby/schemas/identifiers";
import {
  parseShortcodeFor,
  type LedgerPartyId,
} from "@cubby/schemas/identifiers";
import { eq, isNotNull, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import {
  auditLog,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerTransfer,
} from "~/server/db/schema";
import { householdContributionLedger } from "~/server/domains/household-contribution/repo/reports";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { acceptFinancialTransferPair } from "./financial-transfer-accept";
import { suggestFinancialTransferPairs } from "./financial-transfer-pairing";

describe("acceptFinancialTransferPair", () => {
  const ctx = withTestDb("mcp");

  const party = async (name: string, kind: "member" | "household") => {
    const result = await createLedgerParty(
      ctx.db,
      { name, kind, notes: null },
      ctx.actor,
    );
    if (!result.output || !result.entityId)
      throw new Error("expected party output");
    return { code: result.output.id, id: result.entityId };
  };
  const account = (name: string, ledgerPartyId: LedgerPartyId | null) =>
    insertWithShortcode(ctx.db, "financialAccount", {
      name,
      identity: { kind: "cash" },
      ledgerPartyId,
    });
  const transaction = async (
    accountId: EntityId<"financialAccount">,
    amount: number,
    date: string,
    ledgerTransferId: EntityId<"ledgerTransfer"> | null = null,
    status: typeof financialTransaction.$inferSelect.status = "posted",
  ) => {
    const row = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId,
      kind: "account_transfer",
      status,
      amount,
      transactionDate: date,
      postedDate: status === "posted" ? date : null,
      ledgerTransferId,
    });
    return parseShortcodeFor("financialTransaction", row.shortcode);
  };
  const liveTransferCount = async () =>
    (
      await unwrapDb(ctx.db)
        .select({ id: ledgerTransfer.id })
        .from(ledgerTransfer)
        .where(isNull(ledgerTransfer.deletedAt))
    ).length;
  const linkedTransactionCount = async () =>
    (
      await unwrapDb(ctx.db)
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(isNotNull(financialTransaction.ledgerTransferId))
    ).length;

  it("refuses each unmet precondition as data and persists nothing", async () => {
    const memberA = await party("Synthetic member A", "member");
    const memberB = await party("Synthetic member B", "member");
    const [accountA, accountB, unowned] = await Promise.all([
      account("Synthetic checking A", memberA.id),
      account("Synthetic checking B", memberB.id),
      account("Synthetic unowned account", null),
    ]);
    const existing = await insertWithShortcode(ctx.db, "ledgerTransfer", {
      fromPartyId: memberA.id,
      toPartyId: memberB.id,
      amount: 5,
      date: "2026-01-01",
    });
    const out = await transaction(accountA.id, 40, "2026-03-02");
    const inn = await transaction(accountB.id, -40, "2026-03-03");
    const otherOut = await transaction(accountB.id, 40, "2026-03-03");
    const unequalIn = await transaction(accountB.id, -39, "2026-03-03");
    const sameAccountIn = await transaction(accountA.id, -40, "2026-03-03");
    const unownedIn = await transaction(unowned.id, -40, "2026-03-03");
    const linkedIn = await transaction(
      accountB.id,
      -40,
      "2026-03-03",
      existing.id,
    );

    const transfersBefore = await liveTransferCount();
    const linkedBefore = await linkedTransactionCount();
    const cases: Array<[typeof out, typeof out, RegExp]> = [
      [out, otherOut, /Opposite signs required/],
      [inn, out, /Opposite signs required/],
      [out, unequalIn, /Amounts differ/],
      [out, sameAccountIn, new RegExp(`both on account ${accountA.shortcode}`)],
      [out, unownedIn, new RegExp(`Account ${unowned.shortcode} .*no owner`)],
      [out, linkedIn, new RegExp(`${linkedIn} already evidences`)],
    ];
    for (const [outflowTransactionId, inflowTransactionId, reason] of cases) {
      const result = await acceptFinancialTransferPair(
        ctx.db,
        { outflowTransactionId, inflowTransactionId },
        ctx.actor,
      );
      expect(result.canProceed).toBe(false);
      if (result.canProceed) continue;
      expect(result.reason).toMatch(reason);
    }
    expect(await liveTransferCount()).toBe(transfersBefore);
    expect(await linkedTransactionCount()).toBe(linkedBefore);
  });

  it("refuses legs that cannot evidence a transfer, naming the record, and persists nothing", async () => {
    const memberA = await party("Synthetic evidence A", "member");
    const memberB = await party("Synthetic evidence B", "member");
    const [accountA, accountB, closed] = await Promise.all([
      account("Synthetic evidence checking A", memberA.id),
      account("Synthetic evidence checking B", memberB.id),
      account("Synthetic closed checking", memberB.id),
    ]);
    const out = await transaction(accountA.id, 60, "2026-05-02");
    const voidIn = await transaction(
      accountB.id,
      -60,
      "2026-05-03",
      null,
      "void",
    );
    const expectedIn = await transaction(
      accountB.id,
      -60,
      "2026-05-03",
      null,
      "expected",
    );
    const allocatedIn = await transaction(accountB.id, -60, "2026-05-03");
    const bookedIn = await transaction(accountB.id, -60, "2026-05-03");
    const closedIn = await transaction(closed.id, -60, "2026-05-03");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic evidence vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-05-03",
    });
    const [allocatedRow] = await unwrapDb(ctx.db)
      .select({ id: financialTransaction.id })
      .from(financialTransaction)
      .where(eq(financialTransaction.shortcode, allocatedIn));
    await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: allocatedRow!.id,
      purchaseId: purchase.id,
      amount: -60,
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic booked refund",
      cost: -60,
      date: "2026-05-03",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      bookingTransactionCode: bookedIn,
    });
    await unwrapDb(ctx.db)
      .update(financialAccount)
      .set({ deletedAt: new Date() })
      .where(eq(financialAccount.id, closed.id));

    const transfersBefore = await liveTransferCount();
    const linkedBefore = await linkedTransactionCount();
    const cases: Array<[typeof out, RegExp]> = [
      [voidIn, new RegExp(`${voidIn} is void`)],
      [expectedIn, new RegExp(`${expectedIn} is expected`)],
      [allocatedIn, new RegExp(`${allocatedIn} has 1 live allocation`)],
      [bookedIn, new RegExp(`${bookedIn} has 1 live booked Expense`)],
      [
        closedIn,
        new RegExp(`${closedIn} is on deleted account ${closed.shortcode}`),
      ],
    ];
    for (const [inflowTransactionId, reason] of cases) {
      const result = await acceptFinancialTransferPair(
        ctx.db,
        { outflowTransactionId: out, inflowTransactionId },
        ctx.actor,
      );
      expect(result.canProceed).toBe(false);
      if (result.canProceed) continue;
      expect(result.reason).toMatch(reason);
    }
    expect(await liveTransferCount()).toBe(transfersBefore);
    expect(await linkedTransactionCount()).toBe(linkedBefore);
  });

  it("creates one audited transfer from pending and observed legs, preserving status and dates", async () => {
    const memberA = await party("Synthetic payer", "member");
    const household = await party("Synthetic household", "household");
    const [accountA, accountB] = await Promise.all([
      account("Synthetic personal", memberA.id),
      account("Synthetic joint", household.id),
    ]);
    const out = await transaction(
      accountA.id,
      75.5,
      "2026-04-05",
      null,
      "pending",
    );
    const inn = await transaction(
      accountB.id,
      -75.5,
      "2026-04-03",
      null,
      "observed",
    );

    const pairing = await suggestFinancialTransferPairs(ctx.db, {
      transactionIds: [out, inn],
      maxDateDistanceDays: 5,
      maxCandidatesPerTransaction: 3,
    });
    expect(pairing.status).toBe("proposed");
    expect(pairing.suggestions).toHaveLength(2);
    for (const suggestion of pairing.suggestions) {
      expect(suggestion).toMatchObject({
        status: "proposed",
        candidates: [
          {
            outflowTransactionId: out,
            inflowTransactionId: inn,
            dateDistanceDays: 2,
          },
        ],
      });
    }

    const result = await acceptFinancialTransferPair(
      ctx.db,
      { outflowTransactionId: out, inflowTransactionId: inn },
      ctx.actor,
    );
    expect(result).toMatchObject({
      canProceed: true,
      fromPartyId: memberA.code,
      toPartyId: household.code,
      amount: 75.5,
      date: "2026-04-03",
      internalMove: false,
    });
    if (!result.canProceed) return;

    const [transfer] = await unwrapDb(ctx.db)
      .select({ id: ledgerTransfer.id, amount: ledgerTransfer.amount })
      .from(ledgerTransfer)
      .where(eq(ledgerTransfer.shortcode, result.transferId));
    expect(transfer).toBeDefined();
    const legs = await unwrapDb(ctx.db)
      .select({
        shortcode: financialTransaction.shortcode,
        status: financialTransaction.status,
        transactionDate: financialTransaction.transactionDate,
        postedDate: financialTransaction.postedDate,
      })
      .from(financialTransaction)
      .where(eq(financialTransaction.ledgerTransferId, transfer!.id));
    expect(legs).toEqual(
      expect.arrayContaining([
        {
          shortcode: out,
          status: "pending",
          transactionDate: "2026-04-05",
          postedDate: null,
        },
        {
          shortcode: inn,
          status: "observed",
          transactionDate: "2026-04-03",
          postedDate: null,
        },
      ]),
    );
    expect(legs).toHaveLength(2);
    const audits = await unwrapDb(ctx.db)
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, transfer!.id));
    expect(audits.map((row) => row.action)).toContain("create");

    // A second accept of the same legs is refused: both already evidence it.
    const again = await acceptFinancialTransferPair(
      ctx.db,
      { outflowTransactionId: out, inflowTransactionId: inn },
      ctx.actor,
    );
    expect(again).toMatchObject({ canProceed: false });
  });

  it("records a same-owner pair as an internal move outside sent/received", async () => {
    const member = await party("Synthetic mover", "member");
    const other = await party("Synthetic other", "member");
    const [checking, savings, otherAccount] = await Promise.all([
      account("Synthetic checking", member.id),
      account("Synthetic savings", member.id),
      account("Synthetic other checking", other.id),
    ]);
    const asOf = "2026-06-30";
    const before = await householdContributionLedger(ctx.db, { asOf });

    const internal = await acceptFinancialTransferPair(
      ctx.db,
      {
        outflowTransactionId: await transaction(checking.id, 200, "2026-06-01"),
        inflowTransactionId: await transaction(savings.id, -200, "2026-06-02"),
      },
      ctx.actor,
    );
    expect(internal).toMatchObject({
      canProceed: true,
      fromPartyId: member.code,
      toPartyId: member.code,
      internalMove: true,
    });
    const between = await acceptFinancialTransferPair(
      ctx.db,
      {
        outflowTransactionId: await transaction(checking.id, 30, "2026-06-03"),
        inflowTransactionId: await transaction(
          otherAccount.id,
          -30,
          "2026-06-03",
        ),
      },
      ctx.actor,
    );
    expect(between).toMatchObject({ canProceed: true, internalMove: false });

    const after = await householdContributionLedger(ctx.db, { asOf });
    const row = (report: typeof after, code: typeof member.code) =>
      report.parties.find((entry) => entry.party.id === code);
    const moverBefore = row(before, member.code);
    const mover = row(after, member.code);
    expect(mover).toMatchObject({
      transfersSent: 30,
      transfersReceived: 0,
      internalMoves: { count: 1, amount: 200 },
    });
    expect(row(after, other.code)).toMatchObject({
      transfersReceived: 30,
      internalMoves: { count: 0, amount: 0 },
    });
    // The internal move changes no position; only the 30 between parties does.
    expect(mover!.position - (moverBefore?.position ?? 0)).toBe(30);
    expect(after.checks.transferNet).toBe(before.checks.transferNet);
    expect(after.checks.positionNet - before.checks.positionNet).toBe(0);
  });
});
