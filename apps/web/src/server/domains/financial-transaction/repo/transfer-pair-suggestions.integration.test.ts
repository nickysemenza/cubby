import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import type { FinancialAccountIdentity } from "@cubby/schemas/financial-account-fields";
import {
  parseShortcodeFor,
  type FinancialAccountShortcode,
} from "@cubby/schemas/identifiers";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import {
  transferPairJudgment,
  type TransferPairJudgment,
  type TransferPairMovementLabel,
} from "@cubby/schemas/transfer-pair-suggestion";
import { eq, isNull, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { unwrapDb } from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  ledgerTransfer,
  statementRow,
} from "~/server/db/schema";
import { labelTransferPairSuggestions } from "~/server/domains/financial-transaction/service/transfer-pair-labels";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { recordStatementRows } from "~/server/domains/statement-import/repo/statement-row";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";

import {
  applyTransferPair,
  countTransferPairsNeedingLabels,
  currentTransferPair,
  discoverTransferPairs,
  findTransferPairForCharge,
  fingerprintTransferPair,
  generateTransferPairSuggestions,
  transferPairEvidenceFingerprint,
} from "./transfer-pair-suggestions";

/*
 * Failure modes this file guards (#2827):
 * - A provider Transfer category or recorded transfer kind alone pairs clean:
 *   a cashed check filed under Transfer meets a payment-app repayment.
 * - A high-confidence movement label overrides structure: a cross-owner,
 *   competing, distant or unowned pair becomes clean, or a non-clean pair
 *   applies without review.
 * - Uniqueness counts only strong candidates, so a weak competitor hides.
 * - An ATM withdrawal invents a clean virtual cash leg, splits the fee off,
 *   or pairs when the owner has several cash accounts.
 * - Overlapping exports pair one charge twice, or an apply creates a second
 *   transaction for money another export already recorded.
 * - A replayed, stale or concurrent apply pairs a leg twice or leaves a
 *   created leg behind when the pair writer refuses.
 * - Pending, allocated, already-paired or soft-deleted records (or records
 *   on a deleted account or owner) become legs.
 * - A created statement leg carries only one of its charge's refs.
 */
describe("transfer-pair suggestions", () => {
  const ctx = withTestDb();

  type Choice = TransferPairMovementLabel["choice"];
  /** Model stand-in: answers each leg's movement question by its descriptor. */
  const movementPort =
    (answer: (descriptor: string) => Choice, confidence = 0.97): DecisionPort =>
    async (input) => {
      const criteria = input.questions.selection.criteria;
      const keys = Object.keys(criteria);
      const subject = z
        .object({ descriptor: z.string().nullable() })
        .parse(JSON.parse(input.state));
      const wanted = answer(subject.descriptor ?? "");
      const choice = keys.find((key) => criteria[key] === wanted)!;
      return {
        answers: {
          selection: {
            type: "choice",
            choice,
            confidence,
            probabilities: Object.fromEntries(
              keys.map((key) => [
                key,
                key === choice
                  ? confidence
                  : (1 - confidence) / (keys.length - 1),
              ]),
            ),
          },
        },
      };
    };
  const byDescriptor = (descriptor: string): Choice =>
    /TRANSFER|ATM|CARD PAYMENT|PAYMENT RECEIVED/i.test(descriptor)
      ? "account_move"
      : /^CHECK\b/i.test(descriptor)
        ? "insufficient_evidence"
        : "payment";

  const owner = async (name: string) =>
    (await createRepoEntity(ctx, "ledgerParty", { name, kind: "member" }))
      .output!.id;

  const checking: FinancialAccountIdentity = {
    kind: "bank_account",
    institution: "Example Bank",
    accountType: "checking",
  };
  const savings: FinancialAccountIdentity = {
    kind: "bank_account",
    institution: "Example Bank",
    accountType: "savings",
  };
  const account = async (
    name: string,
    ledgerPartyId: Awaited<ReturnType<typeof owner>> | null,
    identity: FinancialAccountIdentity = checking,
  ) =>
    (
      await createRepoEntity(ctx, "financialAccount", {
        name,
        identity,
        ledgerPartyId,
        sourceAliases: ["monarch", "copilot"].map((source) => ({
          source,
          alias: name,
          externalAccountId: null,
        })),
      })
    ).output!.id;

  let position = 0;
  type Row = {
    account: string;
    date: string;
    /** Cubby convention: positive is money out of the account. */
    amount: number;
    description: string;
    category?: string | null;
    status?: "posted" | "pending";
  };
  const statement = (
    rows: Row[],
    options: { source?: string; fingerprint?: string } = {},
  ) =>
    recordStatementRows(
      ctx.db,
      recordStatementRowsInput.parse({
        import: {
          source: options.source ?? "monarch",
          label: "Synthetic export.csv",
          fingerprint: options.fingerprint ?? `synthetic-pairs-${++position}`,
          dateKind: "posted",
          rowCountDeclared: null,
          notes: null,
        },
        rows: rows.map((row) => ({
          accountDescriptor: row.account,
          statementDate: row.date,
          providerAmount: -row.amount,
          merchant: null,
          rawDescription: row.description,
          sourceCategory:
            row.category === undefined ? "Transfer" : row.category,
          providerStatus: row.status ?? "posted",
          providerNotes: null,
          rowPosition: ++position,
        })),
      }),
      ctx.actor,
    );

  const transaction = async (
    accountId: FinancialAccountShortcode,
    amount: number,
    date: string,
    extra: Parameters<typeof createRepoEntity<"financialTransaction">>[2] = {},
  ) =>
    (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId,
        amount,
        kind: "account_transfer",
        status: "posted",
        postedDate: date,
        transactionDate: date,
        merchant: null,
        rawDescription: "ONLINE TRANSFER",
        sourceCategory: "Transfer",
        purchaseId: null,
        allocations: [],
        sourceRefs: [],
        notes: null,
        ...extra,
      })
    ).output!;

  const refresh = async (
    answer: (descriptor: string) => Choice = byDescriptor,
    confidence = 0.97,
  ) => {
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    await labelTransferPairSuggestions(ctx.db, {
      port: movementPort(answer, confidence),
    });
  };

  /** Pending, active publications with their labelled judgments. */
  const pending = async () => {
    const { rows } = await unwrapDb(ctx.db).execute<{
      judgment: unknown;
      fingerprint: string;
    }>(sql`
      SELECT a.judgment, s.fingerprint FROM "AssessmentState" s
      JOIN "Assessment" a ON a.id = s.id
      WHERE s.family = ${assessmentFamily.enum.transfer_pair} AND s.active
        AND s.status = ${suggestionStatus.enum.pending}
    `);
    return rows.map((row) => ({
      judgment: transferPairJudgment.parse(row.judgment),
      fingerprint: String(row.fingerprint),
    }));
  };
  const pendingOn = async (accountId: string) =>
    (await pending()).filter(
      ({ judgment }) =>
        judgment.outflow.accountId === accountId ||
        judgment.inflow.accountId === accountId,
    );

  const liveTransactions = () =>
    unwrapDb(ctx.db)
      .select()
      .from(financialTransaction)
      .where(isNull(financialTransaction.deletedAt));
  const transfers = () =>
    unwrapDb(ctx.db)
      .select()
      .from(ledgerTransfer)
      .where(isNull(ledgerTransfer.deletedAt));
  const partyUuid = async (code: string) =>
    (
      await unwrapDb(ctx.db)
        .select({ id: ledgerParty.id })
        .from(ledgerParty)
        .where(eq(ledgerParty.shortcode, code))
    )[0]!.id;

  const apply = (
    pair: { judgment: TransferPairJudgment; fingerprint: string },
    reviewed?: boolean,
  ) =>
    applyTransferPair(ctx.db, kernelCtx(ctx), {
      key: pair.judgment.key,
      expectedFingerprint: pair.fingerprint,
      ...(reviewed === undefined ? {} : { reviewed }),
    });

  it("pairs two same-owner statement legs clean only after both are labelled, then applies once", async () => {
    const member = await owner("Synthetic member");
    const from = await account("Synthetic checking", member);
    const to = await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 180,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-05",
        amount: -180,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);

    const [raw] = await discoverTransferPairs(ctx.db);
    expect(raw).toMatchObject({
      outflow: {
        accountId: from,
        origin: "statement",
        amount: 180,
        movement: "weak",
        movementLabel: null,
      },
      inflow: { accountId: to, origin: "statement", amount: -180 },
      amount: 180,
      date: "2026-05-04",
      dateGapDays: 1,
      move: "internal",
      clean: false,
      blockers: ["weak_movement"],
    });

    await refresh();
    const [published] = await pending();
    expect(published!.judgment).toMatchObject({
      key: raw!.key,
      clean: true,
      blockers: [],
      outflow: {
        movement: "explicit",
        movementLabel: { choice: "account_move", confidence: "high" },
      },
      inflow: { movement: "explicit" },
    });
    expect(published!.fingerprint).toBe(
      await fingerprintTransferPair(published!.judgment),
    );
    // Labels ride on top of the rule evidence rather than replacing it.
    expect(await transferPairEvidenceFingerprint(published!.judgment)).toBe(
      await transferPairEvidenceFingerprint(raw!),
    );
    expect(
      await findTransferPairForCharge(
        ctx.db,
        published!.judgment.outflow.charge!,
      ),
    ).toEqual({
      key: raw!.key,
      fingerprint: published!.fingerprint,
      clean: true,
    });

    const result = await apply(published!);
    const legs = await liveTransactions();
    expect(legs.map((leg) => Number(leg.amount)).sort((a, b) => a - b)).toEqual(
      [-180, 180],
    );
    expect(new Set(legs.map((leg) => leg.ledgerTransferId)).size).toBe(1);
    const [move] = await transfers();
    expect(move!.fromPartyId).toBe(move!.toPartyId);
    expect(result.transferId).toMatch(/^LTR-/);

    // Replay of the same accept: the legs are paired, so nothing pairs again.
    await expect(apply(published!)).rejects.toThrow(/no longer a candidate/);
    expect(await transfers()).toHaveLength(1);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    expect(await pending()).toEqual([]);
    expect(await discoverTransferPairs(ctx.db)).toEqual([]);
    expect(await currentTransferPair(ctx.db, raw!.key)).toBeNull();
  });

  it("never pairs a check filed under Transfer clean, while a labelled real transfer is", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const wallet = await account("Synthetic wallet", member, {
      kind: "stored_value",
      provider: "Example Pay",
    });
    const reserve = await account("Synthetic savings", member, savings);
    // The check is recorded as a transfer and its category says Transfer.
    await transaction(bank, 75, "2026-05-10", { rawDescription: "CHECK 1042" });
    await statement([
      {
        account: "Synthetic wallet",
        date: "2026-05-11",
        amount: -75,
        description: "Synthetic Friend repayment",
      },
      {
        account: "Synthetic checking",
        date: "2026-05-12",
        amount: 300,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-12",
        amount: -300,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const [check] = await pendingOn(wallet);
    expect(check!.judgment).toMatchObject({
      clean: false,
      outflow: {
        origin: "transaction",
        signals: { kind: "account_transfer", providerCategory: "Transfer" },
        movement: "weak",
      },
      inflow: { movement: "weak" },
    });
    expect(check!.judgment.blockers).toContain("weak_movement");
    await expect(apply(check!)).rejects.toThrow(/review/i);
    expect(await transfers()).toEqual([]);
    expect(await liveTransactions()).toHaveLength(1);

    const [real] = await pendingOn(reserve);
    expect(real!.judgment.clean).toBe(true);
  });

  it("keeps a confidently labelled cross-owner pair out of clean and applies it only on review", async () => {
    const payer = await owner("Synthetic member A");
    const payee = await owner("Synthetic member B");
    await account("Synthetic checking", payer);
    await account("Synthetic brokerage", payee, {
      kind: "other",
      institution: "Example Brokerage",
    });
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-06-01",
        amount: 900,
        description: "ONLINE TRANSFER TO BROKERAGE",
      },
      {
        account: "Synthetic brokerage",
        date: "2026-06-02",
        amount: -900,
        description: "TRANSFER RECEIVED",
      },
    ]);
    await refresh();
    const [pair] = await pending();
    expect(pair!.judgment).toMatchObject({
      move: "between_owners",
      clean: false,
      outflow: { movement: "explicit" },
      inflow: { movement: "explicit" },
      apply: { available: true },
    });
    expect(pair!.judgment.blockers).toEqual(["owners_differ"]);
    await expect(apply(pair!)).rejects.toThrow(/review/i);
    expect(await liveTransactions()).toEqual([]);

    await apply(pair!, true);
    const [move] = await transfers();
    expect(move!.fromPartyId).toBe(await partyUuid(payer));
    expect(move!.toPartyId).toBe(await partyUuid(payee));
    expect(Number(move!.amount)).toBe(900);
  });

  it("treats medium-confidence movement labels as weak", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 40,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -40,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh(byDescriptor, 0.6);
    const [pair] = await pending();
    expect(pair!.judgment.clean).toBe(false);
    expect(pair!.judgment.blockers).toEqual(["weak_movement"]);
  });

  it("requires mutual uniqueness, counting weak competitors, and a date gap of three days or less", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const second = await account("Synthetic second checking", member);
    const reserve = await account("Synthetic savings", member, savings);
    await account("Synthetic card", member, {
      kind: "credit_card",
      issuer: null,
      network: "visa",
    });
    await statement([
      // A weak refund on another account competes for the savings inflow.
      {
        account: "Synthetic checking",
        date: "2026-06-01",
        amount: 250,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-06-02",
        amount: -250,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic card",
        date: "2026-06-03",
        amount: -250,
        description: "EXAMPLE STORE RETURN",
        category: "Shopping",
      },
      // Four days apart: still a candidate, never clean. Six: no candidate.
      {
        account: "Synthetic checking",
        date: "2026-06-10",
        amount: 90,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-06-14",
        amount: -90,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic checking",
        date: "2026-06-20",
        amount: 60,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-06-26",
        amount: -60,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      // Two outflows from different accounts compete for one inflow.
      {
        account: "Synthetic checking",
        date: "2026-07-01",
        amount: 120,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic second checking",
        date: "2026-07-01",
        amount: 120,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-07-02",
        amount: -120,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const pairs = await pendingOn(reserve);
    const of = (amount: number) =>
      pairs.filter(({ judgment }) => judgment.amount === amount);

    const [competed] = of(250).filter(
      ({ judgment }) => judgment.outflow.accountId === bank,
    );
    expect(competed!.judgment.clean).toBe(false);
    expect(competed!.judgment.blockers).toContain("competing_candidates");
    expect(competed!.judgment.competitors).toMatchObject([
      {
        against: "outflow",
        leg: { amount: -250, movement: "weak" },
        dateGapDays: 2,
      },
    ]);

    const [distant] = of(90);
    expect(distant!.judgment).toMatchObject({ dateGapDays: 4, clean: false });
    expect(distant!.judgment.blockers).toEqual(["date_gap"]);
    expect(of(60)).toEqual([]);

    const shared = of(120);
    expect(
      shared.map(({ judgment }) => judgment.outflow.accountId).sort(),
    ).toEqual([bank, second].sort());
    for (const { judgment } of shared) {
      expect(judgment.clean).toBe(false);
      expect(judgment.competitors).toMatchObject([{ against: "inflow" }]);
    }
  });

  it("reviews an unowned pair but refuses to apply it", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", null, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 55,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -55,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const [pair] = await pending();
    expect(pair!.judgment).toMatchObject({
      move: "unowned",
      clean: false,
      inflow: { owner: null },
      apply: { available: false },
    });
    expect(pair!.judgment.blockers).toContain("owner_missing");
    await expect(apply(pair!, true)).rejects.toThrow(/owner/i);
    expect(await liveTransactions()).toEqual([]);
  });

  it("offers a review-only full-amount cash leg on the owner's one cash account", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const cash = await account("Synthetic cash", member, { kind: "cash" });
    const crowded = await owner("Synthetic member with two wallets");
    await account("Synthetic crowded checking", crowded);
    await account("Synthetic cash one", crowded, { kind: "cash" });
    await account("Synthetic cash two", crowded, { kind: "cash" });
    await statement([
      // The bank amount includes the ATM fee.
      {
        account: "Synthetic checking",
        date: "2026-07-01",
        amount: 203,
        description: "ATM WITHDRAWAL 0001",
        category: "Cash & ATM",
      },
      {
        account: "Synthetic crowded checking",
        date: "2026-07-01",
        amount: 103,
        description: "ATM WITHDRAWAL 0002",
        category: "Cash & ATM",
      },
    ]);
    await refresh();
    const pairs = await pending();
    expect(pairs).toHaveLength(1);
    const [pair] = pairs;
    expect(pair!.judgment).toMatchObject({
      outflow: { accountId: bank, origin: "statement", amount: 203 },
      inflow: {
        accountId: cash,
        origin: "cash",
        accountKind: "cash",
        amount: -203,
        transactionId: null,
        refs: [],
      },
      amount: 203,
      move: "internal",
      clean: false,
      apply: { available: true },
    });
    expect(pair!.judgment.blockers).toContain("cash_leg_missing");
    await expect(apply(pair!)).rejects.toThrow(/review/i);

    await apply(pair!, true);
    const legs = await liveTransactions();
    // One cash leg for the full amount; the fee is never inferred.
    expect(legs.map((leg) => Number(leg.amount)).sort((a, b) => a - b)).toEqual(
      [-203, 203],
    );
    expect(legs.find((leg) => Number(leg.amount) === -203)!.kind).toBe(
      "account_transfer",
    );
    expect(new Set(legs.map((leg) => leg.ledgerTransferId)).size).toBe(1);
  });

  it("pairs a hand-entered cash leg as a recorded transaction instead of offering another", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const cash = await account("Synthetic cash", member, { kind: "cash" });
    await transaction(bank, 100, "2026-07-03", {
      rawDescription: "ATM WITHDRAWAL 0003",
      sourceCategory: "Cash & ATM",
    });
    await transaction(cash, -100, "2026-07-03", {
      rawDescription: "Cash from the ATM",
      sourceCategory: null,
    });
    const pairs = await discoverTransferPairs(ctx.db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      outflow: { accountId: bank, origin: "transaction" },
      inflow: { accountId: cash, origin: "transaction" },
    });
  });

  it("blocks clean and creation on an overlapping export until observations converge on one transaction", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const reserve = await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-08-03",
        amount: 400,
        description: "ONLINE TRANSFER TO SAVINGS 7788",
      },
      {
        account: "Synthetic savings",
        date: "2026-08-04",
        amount: -400,
        description: "ONLINE TRANSFER FROM CHECKING 7788",
      },
    ]);
    // The same checking outflow, exported again by another source.
    await statement(
      [
        {
          account: "Synthetic checking",
          date: "2026-08-04",
          amount: 400,
          description: "Online Transfer to Savings",
        },
      ],
      { source: "copilot" },
    );
    await refresh();
    const pairs = await pendingOn(reserve);
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) {
      expect(pair.judgment.clean).toBe(false);
      expect(pair.judgment.blockers).toEqual(
        expect.arrayContaining(["unresolved_overlap", "competing_candidates"]),
      );
      expect(pair.judgment.outflow.overlaps).toHaveLength(1);
      expect(pair.judgment.apply.available).toBe(false);
      await expect(apply(pair, true)).rejects.toThrow(/overlap|statement/i);
    }
    expect(await liveTransactions()).toEqual([]);

    // Statement review converged both observations on one transaction.
    const observed = await unwrapDb(ctx.db)
      .select({
        source: statementRow.source,
        externalId: statementRow.externalId,
      })
      .from(statementRow)
      .where(eq(statementRow.accountDescriptor, "Synthetic checking"));
    await transaction(bank, 400, "2026-08-03", {
      rawDescription: "ONLINE TRANSFER TO SAVINGS 7788",
      sourceRefs: observed,
    });
    await refresh();
    const [converged, ...rest] = await pendingOn(reserve);
    expect(rest).toEqual([]);
    expect(converged!.judgment).toMatchObject({
      outflow: { origin: "transaction", overlaps: [] },
      inflow: { origin: "statement", overlaps: [] },
      competitors: [],
      clean: true,
    });
  });

  it("refuses a stale accept and leaves no created leg behind", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 70,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-05",
        amount: -70,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const [pair] = await pending();
    expect(pair!.judgment.clean).toBe(true);
    // A new competitor arrives after publication.
    await transaction(
      await account("Synthetic second checking", member),
      70,
      "2026-05-05",
    );
    await expect(apply(pair!)).rejects.toThrow(/changed|refresh/i);
    expect(await liveTransactions()).toHaveLength(1);
    expect(await transfers()).toEqual([]);
  });

  it("pairs a shared leg once when two reviewed accepts race", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await account("Synthetic brokerage", member, {
      kind: "other",
      institution: "Example Brokerage",
    });
    await transaction(bank, 500, "2026-09-01");
    await statement([
      {
        account: "Synthetic savings",
        date: "2026-09-02",
        amount: -500,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic brokerage",
        date: "2026-09-02",
        amount: -500,
        description: "TRANSFER RECEIVED",
      },
    ]);
    await refresh();
    const pairs = await pendingOn(bank);
    expect(pairs).toHaveLength(2);
    const results = await Promise.allSettled(
      pairs.map((pair) => apply(pair, true)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await transfers()).toHaveLength(1);
    // The checking leg plus exactly one created inflow; the loser rolled back.
    expect(await liveTransactions()).toHaveLength(2);
  });

  it("excludes pending, allocated, already-paired and soft-deleted legs and deleted accounts or owners", async () => {
    const member = await owner("Synthetic member");
    const bank = await account("Synthetic checking", member);
    const reserve = await account("Synthetic savings", member, savings);
    const gone = await owner("Synthetic departed member");
    const orphaned = await account("Synthetic orphaned checking", gone);
    const closed = await account("Synthetic closed checking", member);
    const purchase = await createRepoEntity(ctx, "purchase", {});
    const paired = await transaction(bank, 11, "2026-05-01");
    await transaction(reserve, -11, "2026-05-01");
    await transaction(bank, 12, "2026-05-02", {
      status: "pending",
      postedDate: null,
    });
    await transaction(bank, 13, "2026-05-03", {
      kind: "purchase",
      purchaseId: purchase.output!.id,
    });
    const deleted = await transaction(bank, 14, "2026-05-04");
    await transaction(orphaned, 15, "2026-05-05");
    await transaction(closed, 16, "2026-05-06");
    await statement([
      {
        account: "Synthetic savings",
        date: "2026-05-02",
        amount: -12,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-03",
        amount: -13,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -14,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-05",
        amount: -15,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-06",
        amount: -16,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
      {
        account: "Synthetic checking",
        date: "2026-05-07",
        amount: 17,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-07",
        amount: -17,
        description: "ONLINE TRANSFER FROM CHECKING",
        status: "pending",
      },
    ]);
    // Soft deletes, set directly: the exclusions are the read's, not the writer's.
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "deletedAt" = now() WHERE shortcode = ${deleted.id}`,
    );
    await unwrapDb(ctx.db)
      .update(ledgerParty)
      .set({ deletedAt: new Date() })
      .where(eq(ledgerParty.shortcode, gone));
    await unwrapDb(ctx.db)
      .update(financialAccount)
      .set({ deletedAt: new Date() })
      .where(eq(financialAccount.shortcode, closed));
    const found = await discoverTransferPairs(ctx.db);
    expect(found.map((pair) => pair.amount)).toEqual([11]);
    const result = await applyTransferPair(ctx.db, kernelCtx(ctx), {
      key: found[0]!.key,
      expectedFingerprint: await fingerprintTransferPair(found[0]!),
      reviewed: true,
    });
    expect(result.outflowTransactionId).toBe(paired.id);
    expect(await discoverTransferPairs(ctx.db)).toEqual([]);
  });

  it("creates a statement leg with every observation's settlement ref", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    const rows: Row[] = [
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 33,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
    ];
    // One charge, exported twice by the same source.
    await statement(rows, { fingerprint: "synthetic-first-export" });
    await statement(rows, { fingerprint: "synthetic-second-export" });
    await statement([
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -33,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    const [pair] = await discoverTransferPairs(ctx.db);
    const observed = await unwrapDb(ctx.db)
      .select({
        externalId: statementRow.externalId,
        legacy: statementRow.legacyExternalId,
      })
      .from(statementRow)
      .where(eq(statementRow.accountDescriptor, "Synthetic checking"));
    expect(observed).toHaveLength(2);
    expect(pair!.outflow.refs.map((ref) => ref.externalId).sort()).toEqual(
      [
        ...new Set([
          ...observed.map((row) => row.externalId),
          observed[0]!.legacy!,
        ]),
      ].sort(),
    );
    const result = await applyTransferPair(ctx.db, kernelCtx(ctx), {
      key: pair!.key,
      expectedFingerprint: await fingerprintTransferPair(pair!),
      reviewed: true,
    });
    const outflowId = (
      await unwrapDb(ctx.db)
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(eq(financialTransaction.shortcode, result.outflowTransactionId))
    )[0]!.id;
    const refs =
      (await settlementRefsFor(ctx.db, [outflowId])).get(outflowId) ?? [];
    expect(refs.map((ref) => ref.externalId).sort()).toEqual(
      pair!.outflow.refs.map((ref) => ref.externalId).sort(),
    );
    expect(
      parseShortcodeFor("financialTransaction", result.inflowTransactionId),
    ).toBeTruthy();
  });

  it("republishes unchanged evidence without dropping its labels", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 21,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -21,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await refresh();
    const before = await pending();
    const again = await generateTransferPairSuggestions(ctx.db, {
      runId: null,
    });
    expect(again.published).toBe(0);
    expect(await pending()).toEqual(before);
    expect(before[0]!.judgment.clean).toBe(true);
  });

  it("labels a pair a later Run rediscovers unchanged, after an earlier Run left it unlabelled", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", member, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 44,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -44,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    // The first Run publishes with automatic AI work off: no label pass.
    const first = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    await generateTransferPairSuggestions(ctx.db, { runId: first });
    const second = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const again = await generateTransferPairSuggestions(ctx.db, {
      runId: second,
    });
    expect(again.published).toBe(0);
    expect(
      await countTransferPairsNeedingLabels(ctx.db, { runId: first }),
    ).toBe(0);
    expect(
      await countTransferPairsNeedingLabels(ctx.db, { runId: second }),
    ).toBe(1);
    const labelled = await labelTransferPairSuggestions(ctx.db, {
      runId: second,
      port: movementPort(byDescriptor),
    });
    expect(labelled.labelled).toBe(1);
    const [pair] = await pending();
    expect(pair!.judgment.clean).toBe(true);
  });

  it("labels structurally blocked pairs for review but never pairs whose apply is unavailable", async () => {
    const member = await owner("Synthetic member");
    await account("Synthetic checking", member);
    await account("Synthetic savings", null, savings);
    await statement([
      {
        account: "Synthetic checking",
        date: "2026-05-04",
        amount: 66,
        description: "ONLINE TRANSFER TO SAVINGS",
      },
      {
        account: "Synthetic savings",
        date: "2026-05-04",
        amount: -66,
        description: "ONLINE TRANSFER FROM CHECKING",
      },
    ]);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    expect(await countTransferPairsNeedingLabels(ctx.db)).toBe(0);
    const [pair] = await pending();
    expect(pair!.judgment.outflow.movementLabel).toBeNull();
  });
});
