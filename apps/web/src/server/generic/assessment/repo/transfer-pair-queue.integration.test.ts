import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { dismissItem } from "~/entity/suggestions/queue/suggestion-review";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  ledgerTransfer,
  run,
  sourceTransactionRecord,
} from "~/server/db/schema";
import { updateFinancialAccount } from "~/server/domains/financial-account/repo";
import {
  generateTransferPairSuggestions,
  lockTransferPairLegs,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { labelTransferPairSuggestions } from "~/server/domains/financial-transaction/service/transfer-pair-labels";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import { advanceStepRun } from "~/server/domains/run/service/step-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { startSweep } from "~/server/domains/run/service/sweep";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { withJobFixtureExecution } from "~/server/testing/background-queue";

import { reviewAssessment } from "./assessment-review";
import { readAssessmentRecordRefs } from "./review-families";
import { acceptCleanSuggestions, listSuggestionPage } from "./suggestion-list";

describe("transfer pairs in the global queue", () => {
  const ctx = withTestDb();

  const seed = async (
    kind: "account_transfer" | "credit_card_payment" = "account_transfer",
    categoryless = false,
  ) => {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic transfer owner",
      kind: "member",
    });
    const cardPayment = kind === "credit_card_payment";
    const destination = cardPayment ? "Synthetic card" : "Synthetic savings";
    for (const name of ["Synthetic checking", destination]) {
      await createRepoEntity(ctx, "financialAccount", {
        name,
        identity:
          cardPayment && name === destination
            ? { kind: "credit_card", issuer: null, network: "visa" }
            : {
                kind: "bank_account",
                institution: "Example Bank",
                accountType:
                  name === "Synthetic checking" ? "checking" : "savings",
              },
        ledgerPartyId: owner.output.id,
        sourceAliases: [
          { source: "monarch", alias: name, externalAccountId: null },
        ],
      });
    }
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "monarch",
          label: "Synthetic transfers.csv",
          fingerprint: "synthetic-queue-pairs",
          dateKind: "posted",
          rowCountDeclared: null,
          notes: null,
        },
        rows: [
          {
            accountDescriptor: "Synthetic checking",
            statementDate: "2026-05-04",
            providerAmount: -180,
            rawDescription: categoryless
              ? "ONLINE TRANSFER CONFIRMED"
              : cardPayment
                ? "CARD PAYMENT TO EXAMPLE CARD"
                : "TRANSFER TO SAVINGS",
            merchant: "Synthetic clearing",
            sourceCategory: categoryless
              ? null
              : cardPayment
                ? "Credit Card Payment"
                : "Transfer",
            providerStatus: "posted",
            providerNotes: null,
            rowPosition: 1,
          },
          {
            accountDescriptor: destination,
            statementDate: "2026-05-05",
            providerAmount: 180,
            rawDescription: categoryless
              ? "ONLINE TRANSFER RECEIVED"
              : cardPayment
                ? "PAYMENT RECEIVED FROM CHECKING"
                : "TRANSFER FROM CHECKING",
            merchant: "Synthetic clearing",
            sourceCategory: categoryless
              ? null
              : cardPayment
                ? "Credit Card Payment"
                : "Transfer",
            providerStatus: "posted",
            providerNotes: null,
            rowPosition: 2,
          },
        ],
      }),
      ctx.actor,
    );
  };

  // Failure mode: a family can discover a pair but never reaches the global
  // clean queue, or bulk apply creates transactions without linking the move.
  it("bulk accepts a clean pair once, creating both statement-backed legs", async () => {
    await seed();
    const runId = await startSweep(ctx.db, ctx.actor, {
      trigger: "manual",
      families: [{ family: "transfer_pair", scope: {} }],
    });
    const [owner] = await getDb(ctx.db)
      .select({ progress: run.progress })
      .from(run)
      .where(eq(run.id, runId));
    const { attempt } = z
      .object({ attempt: z.number() })
      .parse(owner?.progress);
    let outcome: Awaited<ReturnType<typeof advanceStepRun>> | undefined;
    for (let page = 0; page < 5; page++) {
      outcome = await withJobFixtureExecution(
        ctx.db,
        {
          key: `run:${runId}`,
          kind: "run.execute",
          input: { runId, purpose: "sweep" },
          runId,
        },
        () => advanceStepRun(ctx.db, { runId, attempt }),
      );
      if (outcome.kind !== "continue") break;
    }
    expect(outcome?.kind).toBe("finished");
    // The scan's denominator is its frozen seed COUNT, never the pages done.
    const [scan] = await readRunSteps(ctx.db, runId);
    expect(scan).toMatchObject({
      key: "transfer_pair_scan",
      state: "done",
      left: 0,
      meta: { input: { mode: "count" }, tallies: { pairs: 1 } },
    });
    expect(scan!.found).toBeGreaterThan(0);
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "transfer_pair",
          limit: 100,
        })
      ).items[0]?.clean,
    ).toBe(false);
    await labelTransferPairSuggestions(ctx.db, {
      port: answering({ kind: "account_move" }),
    });
    const page = await listSuggestionPage(ctx.db, {
      family: "transfer_pair",
      limit: 100,
    });
    expect(page.items).toHaveLength(1);
    // Every account and owner on either leg gets the same scoped proposal.
    const pairId = page.items[0]!.assessmentId;
    const refs =
      (await readAssessmentRecordRefs(ctx.db, [pairId])).get(pairId) ?? [];
    expect(
      refs.filter((ref) => ref.entity === "financialAccount"),
    ).toHaveLength(2);
    expect(refs.filter((ref) => ref.entity === "ledgerParty")).toHaveLength(1);
    for (const ref of refs) {
      expect(
        (
          await listSuggestionPage(ctx.db, {
            family: "transfer_pair",
            entity: ref.entity,
            recordIds: [ref.id],
          })
        ).items.map((item) => item.assessmentId),
      ).toContain(pairId);
    }
    const merchantMatches = await listSuggestionPage(ctx.db, {
      family: "transfer_pair",
      where: { merchant: { search: "Synthetic clearing" } },
    });
    expect(merchantMatches.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      family: "transfer_pair",
      clean: true,
    });
    const result = await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
      filters: { family: "transfer_pair" },
    });
    expect(result.filter((item) => item.ok && item.applied)).toHaveLength(1);
    const legs = await getDb(ctx.db).select().from(financialTransaction);
    expect(legs.map((leg) => Number(leg.amount)).sort((a, b) => a - b)).toEqual(
      [-180, 180],
    );
    expect(legs[0]?.ledgerTransferId).toBeTruthy();
    expect(legs[1]?.ledgerTransferId).toBe(legs[0]?.ledgerTransferId);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "transfer_pair",
          limit: 100,
        })
      ).items,
    ).toEqual([]);
  });

  // One move can appear as a pair and two statement creates. Accept clean must
  // settle it once without counting its overlapping suggestions as failures.
  it("bulk accepts overlapping families without spurious failures", async () => {
    await seed();
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    await labelTransferPairSuggestions(ctx.db, {
      port: answering({ kind: "account_move" }),
    });
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const rows = await listSuggestionPage(ctx.db, { limit: 100 });
    expect(rows.items.filter((row) => row.clean)).toHaveLength(3);
    const result = await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {});
    expect(result.every((item) => item.ok)).toBe(true);
    expect(result.filter((item) => item.ok && item.applied)).toHaveLength(1);
    expect(
      await getDb(ctx.db).select().from(financialTransaction),
    ).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(ledgerTransfer)).toHaveLength(1);
  });

  // A dismissed coincidence must stay dismissed when evidence is rediscovered.
  it("keeps a dismissed pair suppressed on later Sweeps", async () => {
    await seed();
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    const [row] = (
      await listSuggestionPage(ctx.db, { family: "transfer_pair" })
    ).items;
    await reviewAssessment(ctx.db, kernelCtx(ctx), dismissItem(row!));
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    expect(
      (await listSuggestionPage(ctx.db, { family: "transfer_pair" })).items,
    ).toEqual([]);
  });

  // A transfer-only label pass must update statement clean projections too.
  it("refreshes statement clean after a transfer-only label pass", async () => {
    await seed();
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    expect(
      (
        await listSuggestionPage(ctx.db, { family: "statement_transaction" })
      ).items.every((row) => !row.clean),
    ).toBe(true);
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    await labelTransferPairSuggestions(ctx.db, {
      port: answering({ kind: "account_move" }),
    });
    const rows = (
      await listSuggestionPage(ctx.db, { family: "statement_transaction" })
    ).items;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.clean)).toBe(true);
  });

  // A pre-pair statement must wait on its charge leg before holding its projection.
  it("serializes a pre-pair statement review with a later pair review", async () => {
    await seed();
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const statement = (
      await listSuggestionPage(ctx.db, { family: "statement_transaction" })
    ).items.find(
      (row) =>
        row.family === "statement_transaction" && row.evidence.amount > 0,
    );
    if (statement?.family !== "statement_transaction")
      throw new Error("Expected a statement suggestion");
    expect(statement.evidence.transferPair).toBeNull();
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    const [pair] = (
      await listSuggestionPage(ctx.db, { family: "transfer_pair" })
    ).items;
    if (pair?.family !== "transfer_pair")
      throw new Error("Expected a transfer pair suggestion");

    // Queue the pair first on the statement's one shared leg. The statement
    // then queues behind it, making the pair the deterministic winner on release.
    const barrier = await withTransaction(ctx.db, async (tx) => {
      await lockTransferPairLegs(
        databaseForTransaction(tx),
        pair.evidence.outflow.key,
      );
      const waitForAdvisory = (count: number) =>
        vi.waitFor(
          async () => {
            const { rows } = await getDb(ctx.db).execute<{ count: number }>(
              sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`,
            );
            expect(rows[0]!.count).toBeGreaterThanOrEqual(count);
          },
          { timeout: 5000, interval: 20 },
        );
      const pairReview = Promise.allSettled([
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: pair.assessmentId,
          operationId: crypto.randomUUID(),
          expectedFingerprint: pair.fingerprint!,
          verdict: "correct",
          intent: "apply",
          application: { kind: "transfer_pair" },
        }),
      ]);
      await waitForAdvisory(1);
      const statementReview = Promise.allSettled([
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: statement.assessmentId,
          operationId: crypto.randomUUID(),
          expectedFingerprint: statement.fingerprint!,
          verdict: "correct",
          intent: "apply",
          application: { kind: "statement_transaction", action: "create" },
        }),
      ]);
      await waitForAdvisory(2);
      const pending = Promise.all([pairReview, statementReview]).then(
        (results) => results.flat(),
      );
      const [projection] = await Promise.allSettled([
        withTransaction(ctx.db, async (probe) => {
          await probe.execute(
            sql`SELECT id FROM "AssessmentState" WHERE id=${statement.assessmentId}::uuid FOR UPDATE NOWAIT`,
          );
        }),
      ]);
      return { pending, projection };
    });
    const results = await barrier.pending;
    expect(barrier.projection).toMatchObject({ status: "fulfilled" });
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" ? String(loser.reason) : "").toMatch(
      /stale|no longer|changed/i,
    );
    expect(
      await getDb(ctx.db).select().from(financialTransaction),
    ).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(ledgerTransfer)).toHaveLength(1);
  });

  // Rebuilding rule evidence must not discard the accepted statement kind label
  // and book an unpaired purchase instead of the reviewed account move.
  it("delegates a statement whose transfer kind comes only from its Decision label", async () => {
    await seed("account_transfer", true);
    const [destination] = await getDb(ctx.db)
      .select()
      .from(financialAccount)
      .where(eq(financialAccount.name, "Synthetic savings"));
    const [observed] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord)
      .where(
        eq(sourceTransactionRecord.accountDescriptor, "Synthetic savings"),
      );
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: destination!.shortcode,
      amount: -180,
      status: "posted",
      kind: "account_transfer",
      postedDate: "2026-05-05",
      sourceRefs: [
        { source: observed!.source, externalId: observed!.externalId },
      ],
    });
    await generateTransferPairSuggestions(ctx.db, { runId: null });
    await labelTransferPairSuggestions(ctx.db, {
      port: answering({ kind: "account_move" }),
    });
    await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "account_transfer" }),
    });
    const [row] = (
      await listSuggestionPage(ctx.db, { family: "statement_transaction" })
    ).items;
    expect(row?.clean).toBe(true);
    const result = await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
      filters: { family: "statement_transaction" },
    });
    expect(result.every((item) => item.ok)).toBe(true);
    const legs = await getDb(ctx.db).select().from(financialTransaction);
    expect(legs).toHaveLength(2);
    expect(
      legs.every(
        (leg) =>
          leg.kind === "account_transfer" && leg.ledgerTransferId !== null,
      ),
    ).toBe(true);
    expect(await getDb(ctx.db).select().from(ledgerTransfer)).toHaveLength(1);
  });

  // Failure mode: statement creates retain #2823's blanket refusal, or bypass
  // the pair writer and leave two independent legs after Accept clean.
  it.each(["account_transfer", "credit_card_payment"] as const)(
    "accepts a statement %s create through the same pair writer",
    async (kind) => {
      await seed(kind);
      await generateTransferPairSuggestions(ctx.db, { runId: null });
      await labelTransferPairSuggestions(ctx.db, {
        port: answering({ kind: "account_move" }),
      });
      await generateStatementSuggestionPage(ctx.db, {
        after: null,
        runId: null,
      });
      const page = await listSuggestionPage(ctx.db, {
        family: "statement_transaction",
        limit: 100,
      });
      expect(page.items).toHaveLength(2);
      expect(page.items.every((row) => row.clean)).toBe(true);
      for (const row of page.items) {
        if (row.family !== "statement_transaction")
          throw new Error("Expected statement suggestion");
        expect(row.evidence.create?.kind).toBe(kind);
      }
      const result = await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
        filters: { family: "statement_transaction" },
      });
      expect(result.filter((item) => item.ok && item.applied)).toHaveLength(1);
      const legs = await getDb(ctx.db).select().from(financialTransaction);
      expect(legs).toHaveLength(2);
      const transfers = await getDb(ctx.db)
        .select()
        .from(ledgerTransfer)
        .where(eq(ledgerTransfer.id, legs[0]!.ledgerTransferId!));
      expect(transfers).toHaveLength(1);
      expect(transfers[0]?.fromPartyId).toBe(transfers[0]?.toPartyId);
    },
  );

  // Failure mode: an account changes owners after labelling, but the saved
  // clean flag still authorizes a pair across people without renewed review.
  it.each(["account_transfer", "credit_card_payment"] as const)(
    "refuses stale %s clean evidence after an owner changes",
    async (kind) => {
      await seed(kind);
      await generateTransferPairSuggestions(ctx.db, { runId: null });
      await labelTransferPairSuggestions(ctx.db, {
        port: answering({ kind: "account_move" }),
      });
      await generateStatementSuggestionPage(ctx.db, {
        after: null,
        runId: null,
      });
      expect(
        (
          await listSuggestionPage(ctx.db, { family: "statement_transaction" })
        ).items.every((row) => row.clean),
      ).toBe(true);
      const [pair] = (
        await listSuggestionPage(ctx.db, { family: "transfer_pair" })
      ).items;
      if (pair?.family !== "transfer_pair")
        throw new Error("Expected transfer pair");
      expect(pair.clean).toBe(true);
      const other = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic other owner",
        kind: "member",
      });
      await updateFinancialAccount(
        ctx.db,
        pair.evidence.inflow.accountId,
        { ledgerPartyId: other.output.id },
        ctx.actor,
      );
      expect(
        (await listSuggestionPage(ctx.db, { family: "transfer_pair" })).items,
      ).toEqual([]);
      const bulk = await acceptCleanSuggestions(ctx.db, kernelCtx(ctx), {
        filters: { family: "statement_transaction" },
      });
      expect(bulk).toHaveLength(2);
      expect(bulk.every((item) => !item.ok)).toBe(true);
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: pair.assessmentId,
          operationId: crypto.randomUUID(),
          expectedFingerprint: pair.fingerprint,
          verdict: "correct",
          intent: "apply",
          application: { kind: "transfer_pair" },
        }),
      ).rejects.toThrow(/changed|refresh|clean/i);
      expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
        [],
      );
      expect(await getDb(ctx.db).select().from(ledgerTransfer)).toEqual([]);
    },
  );
});
