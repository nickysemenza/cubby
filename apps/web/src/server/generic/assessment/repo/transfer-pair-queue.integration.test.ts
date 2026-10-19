import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { financialTransaction, ledgerTransfer, run } from "~/server/db/schema";
import { updateFinancialAccount } from "~/server/domains/financial-account/repo";
import { generateTransferPairSuggestions } from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { labelTransferPairSuggestions } from "~/server/domains/financial-transaction/service/transfer-pair-labels";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import { advanceStepRun } from "~/server/domains/run/service/step-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { startSweep } from "~/server/domains/run/service/sweep";
import { answering } from "~/server/domains/statement-import/repo/statement-decision-port.fixtures";
import { recordStatementRows } from "~/server/domains/statement-import/repo/statement-row";
import { generateStatementSuggestionPage } from "~/server/domains/statement-import/repo/statement-suggestions";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";

import { reviewAssessment } from "./assessment-review";
import { acceptCleanSuggestions, listSuggestionPage } from "./suggestion-list";

describe("transfer pairs in the global queue", () => {
  const ctx = withTestDb();

  const seed = async (
    kind: "account_transfer" | "credit_card_payment" = "account_transfer",
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
    await recordStatementRows(
      ctx.db,
      recordStatementRowsInput.parse({
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
            rawDescription: cardPayment
              ? "CARD PAYMENT TO EXAMPLE CARD"
              : "TRANSFER TO SAVINGS",
            merchant: null,
            sourceCategory: cardPayment ? "Credit Card Payment" : "Transfer",
            providerStatus: "posted",
            providerNotes: null,
            rowPosition: 1,
          },
          {
            accountDescriptor: destination,
            statementDate: "2026-05-05",
            providerAmount: 180,
            rawDescription: cardPayment
              ? "PAYMENT RECEIVED FROM CHECKING"
              : "TRANSFER FROM CHECKING",
            merchant: null,
            sourceCategory: cardPayment ? "Credit Card Payment" : "Transfer",
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
    const launcher: WorkflowLauncher = {
      create: async () => {},
      terminate: async () => {},
      status: async () => ({ state: "running", error: null }),
    };
    const runId = await startSweep(
      ctx.db,
      ctx.actor,
      { trigger: "manual", families: [{ family: "transfer_pair", scope: {} }] },
      launcher,
    );
    const [owner] = await getDb(ctx.db)
      .select({ progress: run.progress })
      .from(run)
      .where(eq(run.id, runId));
    const { attempt } = z
      .object({ attempt: z.number() })
      .parse(owner?.progress);
    let outcome: Awaited<ReturnType<typeof advanceStepRun>> | undefined;
    for (let page = 0; page < 5; page++) {
      outcome = await advanceStepRun(
        ctx.db,
        { runId, attempt },
        undefined,
        launcher,
      );
      if (outcome.kind !== "continue") break;
    }
    expect(outcome?.kind).toBe("finished");
    expect(await readRunSteps(ctx.db, runId)).toEqual([
      expect.objectContaining({
        key: "transfer_pair",
        state: "done",
        found: 1,
        done: 1,
      }),
    ]);
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
