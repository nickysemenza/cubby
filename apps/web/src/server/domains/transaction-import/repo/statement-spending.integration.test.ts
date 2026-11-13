import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { statementDecisionInput } from "@cubby/schemas/statement-decision";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { expectStatementBudget } from "tooling/statement-budget";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { shiftPlainDate } from "~/lib/household-date";
import { modelInput } from "~/server/ai/model-asks";
import {
  withDatabaseOperationMetrics,
  withDatabaseOperationPhase,
} from "~/server/db/db-observability";
import { getDb } from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import {
  evidenceBinding,
  drift,
  ask,
  recordKey,
} from "~/server/db/kernel-schema";
import {
  expense,
  financialTransaction,
  financialAccount,
  financialTransactionAllocation,
} from "~/server/db/schema";
import {
  purchase as purchaseTable,
  sourceTransactionRecord,
  sourceOccurrence,
  vendor as vendorTable,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { updateFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import { expenseRecords } from "~/server/domains/financial-transaction/repo/purchase-event-records";
import { readExistingOrderCandidates } from "~/server/domains/purchase-import/repo/existing-order-candidates";
import { purchaseWorkFacts } from "~/server/domains/purchase/repo/work-facts";
import { decideStatement } from "~/server/domains/transaction-import/repo/statement-decisions";
import { insertManyWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { householdWrite, emitWrites, machinery } from "~/server/kernel/api";
import { decide, reconcileNow } from "~/server/kernel/api";
import { append, evidenceRow } from "~/server/kernel/api";
import { runQueuedAsks } from "~/server/kernel/ask";
import { productionKernel } from "~/server/kernel/kernel";

import { recordSourceTransactionRecords } from "./source-transaction-record";

// Failure modes: a clean accept writes only settlement evidence; a matched
// charge disappears before its spending is booked; unchanged re-import skips
// work; the automatic sample/optional switch withholds clean import spending.
describe("statement spending review and re-import", () => {
  const ctx = withTestDb();
  async function fixture(
    providerTransactionId: string | null = null,
    ownerKind: "member" | "household" = "member",
    amount = 42.5,
    knownVendor = true,
  ) {
    const owner = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic statement member",
      kind: ownerKind,
    });
    const account = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic statement card",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: owner.output.id,

      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic card 4242",
          externalAccountId: null,
        },
      ],
    });
    if (knownVendor)
      await createRepoIdentity(ctx, "vendor", { name: "Synthetic Orchard" });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      {
        name: "Synthetic grocery spend",
      },
    );
    const advice = financialSpendingAdvice.parse({
      spendingCategoryId: category.id,
      categoryConfidence: "high",
      vendorName: "Synthetic Orchard",
      vendorConfidence: "high",
      counterparty: "business",
    });
    const input = recordSourceTransactionRecordsInput.parse({
      import: {
        source: "monarch",
        label: "synthetic-spending.csv",
        fingerprint: "synthetic-spending-import",
        dateKind: "posted",
        rowCountDeclared: null,
        notes: null,
      },
      rows: [
        {
          accountDescriptor: "Synthetic card 4242",
          statementDate: "2026-05-04",
          providerAmount: -amount,
          merchant: "Synthetic Orchard",
          rawDescription: "SYNTHETIC ORCHARD",
          sourceCategory: "Groceries",
          providerTransactionId,
          ...(providerTransactionId
            ? {
                providerAccountId: "synthetic-statement-account",
                providerData: {
                  id: providerTransactionId,
                  account_id: "synthetic-statement-account",
                },
              }
            : {}),
          providerStatus: "posted",
          providerNotes: null,
          rowPosition: 1,
        },
      ],
    });
    const recorded = await recordSourceTransactionRecords(
      ctx.db,
      input,
      ctx.actor,
    );
    return { input, recorded, account, advice };
  }
  it("matches statement lumps in cents and reports work amounts in dollars", async () => {
    const setup = await fixture("money-unit-boundary", "member", 19.99);
    const [observation] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const result = await decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: observation!.shortcode,
        accountId: setup.account.output.id,
        application: { action: "book", kindOverride: "purchase" },
      }),
    );
    expect(result.status).toBe("applied");
    const [seller] = await getDb(ctx.db)
      .select()
      .from(vendorTable)
      .where(eq(vendorTable.name, "Synthetic Orchard"));
    const [account] = await getDb(ctx.db)
      .select()
      .from(financialAccount)
      .where(eq(financialAccount.shortcode, setup.account.output.id));
    const candidates = await readExistingOrderCandidates(
      ctx.db,
      {
        ledgerPartyId: account!.ledgerPartyId!,
        vendorId: seller!.id,
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-order",
        threadId: null,
        receivedAt: new Date("2026-05-04T20:00:00Z"),
      },
      { lumpAmount: 19.99 },
    );
    expect(candidates).toEqual([
      expect.objectContaining({ basis: "statement_lump", amount: 19.99 }),
    ]);
    expect(
      await getDb(ctx.db)
        .select({ amount: purchaseWorkFacts().amount })
        .from(purchaseTable),
    ).toEqual([{ amount: 19.99 }]);
  });

  it("books a statement charge with stable linked records through the kernel", async () => {
    const setup = await fixture("kernel-charge-one");
    const [observation] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const applied = await decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: observation!.shortcode,
        accountId: setup.account.output.id,
        application: { action: "book", kindOverride: "purchase" },
      }),
    );
    expect(applied.status).toBe("applied");
    const transactions = await getDb(
      ctx.db,
    ).query.financialTransaction.findMany();
    expect(transactions).toHaveLength(1);
    const scope = { kind: "purchaseEvent", key: transactions[0]!.id };
    const outcomes = await reconcileNow(ctx.db, [scope]);
    expect(outcomes[0]?.error).toBeUndefined();
    expect(outcomes[0]?.gaps).toEqual([]);
    const before = await getDb(ctx.db).execute<{
      id: string;
      expense: string;
      allocation: string;
      costMinor: string;
      amountMinor: string;
    }>(
      sql`SELECT p.id, e.id AS expense, a.id AS allocation, e."costMinor", a."amountMinor" FROM "Purchase" p JOIN "Expense" e ON e."purchaseId"=p.id JOIN "FinancialTransactionAllocation" a ON a."purchaseId"=p.id`,
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({
      costMinor: "4250",
      amountMinor: "4250",
    });
    const ledgerBeforeReplay = await ledgerRows();
    await recordSourceTransactionRecords(ctx.db, setup.input, ctx.actor);
    await reconcileNow(ctx.db, [scope]);
    expect(await ledgerRows()).toEqual(ledgerBeforeReplay);
    const after = await getDb(ctx.db).execute<{
      id: string;
      expense: string;
      allocation: string;
      costMinor: string;
      amountMinor: string;
    }>(
      sql`SELECT p.id, e.id AS expense, a.id AS allocation, e."costMinor", a."amountMinor" FROM "Purchase" p JOIN "Expense" e ON e."purchaseId"=p.id JOIN "FinancialTransactionAllocation" a ON a."purchaseId"=p.id`,
    );
    expect(after.rows).toEqual(before.rows);
  });
  it("files statement and merchant Asks and keeps abstentions and peer transfers unbooked", async () => {
    const setup = await fixture("synthetic-producer", "member", 42.5, false);
    const [occurrence] = await getDb(ctx.db).select().from(sourceOccurrence);
    const scope = { kind: "bankEvent", key: occurrence!.id };
    await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: `bank:${occurrence!.id}`,
        field: "accountId",
        value: setup.account.output.id,
      },
    ]);
    await reconcileNow(ctx.db, [scope]);
    const kernel = await productionKernel();
    let kind: string | null = null;
    let party = "business";
    const called: string[] = [];
    const registry = {
      ...kernel.registry,
      asks: new Map(
        [...kernel.registry.asks].map(([feature, spec]) => [
          feature,
          {
            ...spec,
            admit: undefined,
            produce: async (raw: unknown) => {
              const input = modelInput.parse(raw);
              called.push(feature);
              if (input.kind !== "choice")
                return {
                  output: {
                    value: {
                      name: "Synthetic Orchard",
                      confidence: "high",
                      counterparty: "business",
                    },
                    model: "synthetic",
                  },
                };
              const choice =
                feature === "statement-counterparty"
                  ? party
                  : feature === "merchant-identity-support"
                    ? "supported_business"
                    : kind;
              return {
                output: {
                  value: {
                    selectedIndex:
                      choice === null ? null : input.choices.indexOf(choice),
                    confidence: "high",
                  },
                  model: "synthetic",
                },
              };
            },
          },
        ]),
      ),
    };
    await runQueuedAsks(ctx.db, registry, 4);
    expect(called).toEqual(
      expect.arrayContaining([
        "statement-transaction-kind",
        "statement-counterparty",
      ]),
    );
    const abstention = await reconcileNow(ctx.db, [scope]);
    expect(abstention[0]?.gaps.length).toBeGreaterThan(0);
    expect((await ledgerRows()).transactions).toHaveLength(0);
    // A new input envelope gets a fresh producer answer for the peer rail case.
    const peerInput = {
      ...setup.input,
      import: { ...setup.input.import, fingerprint: "synthetic-peer-import" },
      rows: setup.input.rows.map((row) => ({
        ...row,
        providerTransactionId: "synthetic-peer",
        rawDescription: "VENMO PAYMENT SYNTHETIC PERSON",
        sourceCategory: "Transfer",
      })),
    };
    await recordSourceTransactionRecords(ctx.db, peerInput, ctx.actor);
    const [peer] = await getDb(ctx.db)
      .select()
      .from(sourceOccurrence)
      .where(eq(sourceOccurrence.providerIdentity, "synthetic-peer"));
    const peerScope = { kind: "bankEvent", key: peer!.id };
    await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: `bank:${peer!.id}`,
        field: "accountId",
        value: setup.account.output.id,
      },
    ]);
    await reconcileNow(ctx.db, [peerScope]);
    kind = "account_transfer";
    party = "person";
    await runQueuedAsks(ctx.db, registry, 4);
    const peerResult = await reconcileNow(ctx.db, [peerScope]);
    expect(peerResult[0]?.gaps.length).toBeGreaterThan(0);
    expect((await ledgerRows()).transactions).toHaveLength(0);
    // Member classification lets the original charge reach merchant identity.
    await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: `bank:${occurrence!.id}`,
        field: "kind",
        value: "purchase",
      },
    ]);
    await reconcileNow(ctx.db, [scope]);
    const [transaction] = await getDb(ctx.db)
      .select()
      .from(financialTransaction);
    await reconcileNow(ctx.db, [
      { kind: "purchaseEvent", key: transaction!.id },
    ]);
    expect(
      (await getDb(ctx.db).select().from(ask)).map((row) => row.feature),
    ).toContain("merchant-identity");
    await runQueuedAsks(ctx.db, registry, 4);
    expect(called).toContain("merchant-identity");
  });
  it("lets a newer finance apply kind override supersede a member edit", async () => {
    const setup = await fixture("synthetic-kind-override");
    const [observation] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    await decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: observation!.shortcode,
        accountId: setup.account.output.id,
        application: { action: "create", kindOverride: "other" },
      }),
    );
    const [transaction] = await getDb(ctx.db)
      .select()
      .from(financialTransaction);
    await updateFinancialTransaction(
      ctx.db,
      parseShortcodeFor("financialTransaction", transaction!.shortcode),
      { kind: "adjustment" },
      ctx.actor,
    );
    expect((await ledgerRows()).transactions[0]?.kind).toBe("adjustment");
    await applyKernelCharge(setup);
    expect((await ledgerRows()).transactions[0]?.kind).toBe("purchase");
  });
  const applyKernelCharge = async (
    setup: Awaited<ReturnType<typeof fixture>>,
    action: "create" | "book" = "book",
  ) => {
    const [row] = await getDb(ctx.db).select().from(sourceTransactionRecord);
    return decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: row!.shortcode,
        accountId: setup.account.output.id,
        application: { action, kindOverride: "purchase" },
      }),
    );
  };
  const ledgerRows = async () => ({
    transactions: await getDb(ctx.db).select().from(financialTransaction),
    purchases: await getDb(ctx.db).select().from(purchaseTable),
    expenses: await getDb(ctx.db).select().from(expense),
    allocations: await getDb(ctx.db)
      .select()
      .from(financialTransactionAllocation),
  });
  it("retains a statement rejection through a kernel replay", async () => {
    const setup = await fixture("kernel-reject");
    const [observation] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const result = await decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: observation!.shortcode,
        application: { action: "reject" },
      }),
    );
    expect(result.status).toBe("rejected");
    await reconcileNow(ctx.db, [
      { kind: "bankEvent", key: observation!.occurrenceId },
    ]);
    expect(await ledgerRows()).toEqual({
      transactions: [],
      purchases: [],
      expenses: [],
      allocations: [],
    });
    expect(setup.recorded).toBeDefined();
  });
  it("attaches statement evidence to the older reviewed bank event", async () => {
    const setup = await fixture("kernel-attach");
    const target = await createRepoIdentity(ctx, "financialTransaction", {
      accountId: setup.account.output.id,
      amount: 42.5,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-05-04",
      transactionDate: "2026-05-04",
      merchant: "Synthetic Orchard",
    });
    const [observation] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const result = await decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: observation!.shortcode,
        accountId: setup.account.output.id,
        application: {
          action: "attach",
          kindOverride: "purchase",
          transactionId: target.output.id,
          fields: ["amount", "status"],
        },
      }),
    );
    expect(result.transactionId).toBe(target.output.id);
    const live = (await ledgerRows()).transactions.filter(
      (row) => row.deletedAt === null,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.shortcode).toBe(target.output.id);
    const [first] = await getDb(ctx.db).select().from(sourceOccurrence);
    const secondInput = {
      ...setup.input,
      import: {
        ...setup.input.import,
        source: "mint",
        fingerprint: "synthetic-cross-source",
      },
    };
    await recordSourceTransactionRecords(ctx.db, secondInput, ctx.actor);
    const [other] = await getDb(ctx.db)
      .select()
      .from(sourceOccurrence)
      .where(eq(sourceOccurrence.source, "mint"));
    const second = other!.id;
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({
        acceptedTransactionId: live[0]!.id,
        accountId: live[0]!.accountId,
        reviewState: "ready",
      })
      .where(eq(sourceOccurrence.id, second));
    await emitWrites(ctx.db, {
      table: sourceOccurrence,
      ids: [second],
      columns: ["acceptedTransactionId", "accountId", "reviewState"],
    });
    await reconcileNow(ctx.db, [{ kind: "bankEvent", key: second }]);
    await recordSourceTransactionRecords(ctx.db, setup.input, ctx.actor);
    await recordSourceTransactionRecords(ctx.db, secondInput, ctx.actor);
    await reconcileNow(ctx.db, [
      { kind: "bankEvent", key: first!.id },
      { kind: "bankEvent", key: second },
    ]);
    const after = await ledgerRows();
    expect(after.transactions.filter((row) => !row.deletedAt)).toHaveLength(1);
    expect(after.purchases.filter((row) => !row.deletedAt)).toHaveLength(1);
    expect(after.expenses.filter((row) => !row.deletedAt)).toHaveLength(1);

    expect(
      (await getDb(ctx.db).select().from(sourceOccurrence))[0]
        ?.acceptedTransactionId,
    ).toBe(live[0]?.id);
  });
  it("leaves a possible manual transaction duplicate unbooked until identity is decided", async () => {
    const setup = await fixture("manual-duplicate");
    const manual = await createRepoIdentity(ctx, "financialTransaction", {
      accountId: setup.account.output.id,
      amount: 42.5,
      kind: "purchase",
      status: "posted",
      transactionDate: "2026-05-04",
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
    });
    const [manualTransaction] = await getDb(ctx.db)
      .select()
      .from(financialTransaction);
    await reconcileNow(ctx.db, [
      { kind: "purchaseEvent", key: manualTransaction!.id },
    ]);
    const [occurrence] = await getDb(ctx.db).select().from(sourceOccurrence);
    await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: `bank:${occurrence!.id}`,
        field: "accountId",
        value: setup.account.output.id,
      },
      {
        channel: "assignment",
        kind: "set",
        subject: `bank:${occurrence!.id}`,
        field: "kind",
        value: "purchase",
      },
    ]);
    const outcomes = await reconcileNow(ctx.db, [
      { kind: "bankEvent", key: occurrence!.id },
    ]);
    expect(
      outcomes
        .flatMap((row) => row.gaps)
        .flatMap((gap) => gap.actions)
        .map((action) => action.kind),
    ).toEqual(["same", "distinct"]);
    expect((await ledgerRows()).transactions).toHaveLength(1);
    expect((await ledgerRows()).purchases).toHaveLength(1);
    expect((await ledgerRows()).expenses).toHaveLength(1);
    const [transaction] = await getDb(ctx.db)
      .select()
      .from(financialTransaction);
    expect(transaction!.shortcode).toBe(manual.output.id);
    await decide(ctx.db, ctx.actor, [
      {
        channel: "identity",
        kind: "same",
        subject: `bank:${occurrence!.id}`,
        field: `financialTransaction:${transaction!.id}`,
      },
    ]);
    await reconcileNow(ctx.db, [{ kind: "bankEvent", key: occurrence!.id }]);
    expect((await ledgerRows()).transactions).toHaveLength(1);
    expect((await ledgerRows()).purchases).toHaveLength(1);
    expect((await ledgerRows()).expenses).toHaveLength(1);
  });

  it("retains old partly paid candidates and invalidates them when their capacity closes", async () => {
    const setup = await fixture("old-partial");
    const [seller] = await getDb(ctx.db)
      .select()
      .from(vendorTable)
      .where(eq(vendorTable.name, "Synthetic Orchard"));
    const purchase = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller!.shortcode,
      date: "2020-01-01",
    });
    const line = await createRepoIdentity(ctx, "expense", {
      name: "Synthetic partly paid history",
      purchaseId: purchase.output.id,
      date: "2020-01-01",
      cost: 100,
      lineKind: "principal",
      costType: "materials",
      trade: "other",
    });
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: setup.account.output.id,
      amount: 10,
      kind: "purchase",
      status: "posted",
      transactionDate: "2020-01-01",
      postedDate: "2020-01-01",
      allocations: [{ purchaseId: purchase.output.id, amount: 10 }],
    });
    const [observation] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const applied = await decideStatement(
      ctx.db,
      ctx.actor,
      statementDecisionInput.parse({
        observationId: observation!.shortcode,
        accountId: setup.account.output.id,
        application: { action: "book", kindOverride: "purchase" },
      }),
    );
    expect(applied.status).toBe("waiting");
    expect((await ledgerRows()).purchases).toHaveLength(1);
    const [transaction] = await getDb(ctx.db)
      .select()
      .from(financialTransaction)
      .where(eq(financialTransaction.shortcode, applied.transactionId!));
    await updateExpense(ctx.db, line.output.id, { cost: 10 }, ctx.actor);
    const pending = await getDb(ctx.db).execute<{ n: number }>(
      sql`SELECT count(*)::int n FROM "ScopeDirty" WHERE "scopeKind"='purchaseEvent' AND "scopeKey"=${transaction!.id}`,
    );
    expect(pending.rows).toEqual([{ n: 1 }]);
    const outcomes = await reconcileNow(ctx.db, [
      { kind: "purchaseEvent", key: transaction!.id },
    ]);
    expect(outcomes.flatMap((outcome) => outcome.gaps)).toEqual([]);
    expect((await ledgerRows()).purchases).toHaveLength(2);
  });

  it("keeps an ambiguous kernel charge unbooked until a same decision", async () => {
    const setup = await fixture("kernel-ambiguous");
    const [seller] = await getDb(ctx.db)
      .select()
      .from(vendorTable)
      .where(eq(vendorTable.name, "Synthetic Orchard"));
    const purchase = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller!.shortcode,
      date: "2026-05-04",
    });
    await createRepoIdentity(ctx, "expense", {
      name: "Synthetic accepted receipt",
      purchaseId: purchase.output.id,
      date: "2026-05-04",
      cost: 42.5,
      lineKind: "principal",
      costType: "materials",
      trade: "other",
    });
    const applied = await applyKernelCharge(setup);
    expect(applied.status).toBe("waiting");
    const [transaction] = await getDb(ctx.db)
      .select()
      .from(financialTransaction);
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toHaveLength(0);
    const read = await machinery(ctx.db, ctx.actor, {
      entity: "financialTransaction",
      id: transaction!.id,
    });
    const action = read.gaps.items
      .flatMap((gap) => gap.actions)
      .find((action) => action.kind === "same");
    expect(action).toBeDefined();
    await decide(ctx.db, ctx.actor, [
      {
        channel: "identity",
        kind: "same",
        subject: action!.subject,
        field: action!.field,
      },
    ]);
    const result = await reconcileNow(ctx.db, [
      { kind: "purchaseEvent", key: transaction!.id },
    ]);
    expect(result[0]?.gaps).toEqual([]);
    const rows = await ledgerRows();
    expect(rows.purchases).toHaveLength(1);
    expect(rows.expenses).toHaveLength(1);
    expect(rows.allocations).toHaveLength(1);
    expect(rows.allocations[0]?.amountMinor).toBe(4250n);
  });
  it("honours a recorded split when its kernel charge is rerun", async () => {
    const setup = await fixture("kernel-split");
    const [seller] = await getDb(ctx.db)
      .select()
      .from(vendorTable)
      .where(eq(vendorTable.name, "Synthetic Orchard"));
    const purchases = [];
    for (const [index, cost] of [25, 17.5].entries()) {
      const purchase = await createRepoIdentity(ctx, "purchase", {
        vendorId: seller!.shortcode,
        date: "2026-05-04",
      });
      await createRepoIdentity(ctx, "expense", {
        name: `Synthetic split ${index}`,
        purchaseId: purchase.output.id,
        date: "2026-05-04",
        cost,
        lineKind: "principal",
        costType: "materials",
        trade: "other",
      });
      purchases.push(purchase.output.id);
    }
    const applied = await applyKernelCharge(setup, "create");
    await updateFinancialTransaction(
      ctx.db,
      applied.transactionId!,
      {
        allocations: [
          { purchaseId: purchases[0]!, amount: 25 },
          { purchaseId: purchases[1]!, amount: 17.5 },
        ],
      },
      ctx.actor,
    );
    const before = await ledgerRows();
    const outcome = await reconcileNow(ctx.db, [
      { kind: "purchaseEvent", key: before.transactions[0]!.id },
    ]);
    expect(outcome[0]?.gaps).toEqual([]);
    expect(await ledgerRows()).toEqual(before);
    expect(before.allocations.map((row) => row.amountMinor).sort()).toEqual([
      1750n,
      2500n,
    ]);
  });
  it("preserves a member Expense category decision through kernel recomputation", async () => {
    const setup = await fixture("kernel-category");
    await applyKernelCharge(setup);
    const before = await ledgerRows();
    await updateExpense(
      ctx.db,
      parseShortcodeFor("expense", before.expenses[0]!.shortcode),
      { spendingCategoryId: setup.advice.spendingCategoryId },
      ctx.actor,
    );
    const saved = (await ledgerRows()).expenses[0]!;
    expect(saved.spendingCategoryId).not.toBeNull();
    await reconcileNow(ctx.db, [
      { kind: "purchaseEvent", key: before.transactions[0]!.id },
    ]);
    expect((await ledgerRows()).expenses[0]).toEqual(saved);
  });
  it("conserves a baseline Purchase across two charges and applies field decisions during disagreement", async () => {
    const setup = await fixture("kernel-split-baseline", "member", 100);
    await applyKernelCharge(setup);
    const before = await ledgerRows();
    const first = before.transactions[0]!;
    const line = before.expenses[0]!;
    const manualId = crypto.randomUUID();
    const [owned] = await getDb(ctx.db)
      .select()
      .from(recordKey)
      .where(eq(recordKey.entityId, line.id));
    await householdWrite(ctx.db, async (tx) =>
      withKernelApply(null, async () => {
        await getDb(tx)
          .update(financialTransaction)
          .set({ amount: 6000n })
          .where(eq(financialTransaction.id, first.id));
        await getDb(tx)
          .update(financialTransactionAllocation)
          .set({ amountMinor: 6000n })
          .where(eq(financialTransactionAllocation.transactionId, first.id));
        const [second] = await insertManyWithShortcode(
          tx,
          "financialTransaction",
          [
            {
              accountId: first.accountId,
              kind: "purchase",
              status: "posted",
              amount: 4000n,
              postedDate: first.postedDate,
              transactionDate: first.transactionDate,
            },
          ],
        );
        await getDb(tx).insert(financialTransactionAllocation).values({
          transactionId: second!.id,
          purchaseId: line.purchaseId!,
          amountMinor: 4000n,
        });
        await getDb(tx).insert(evidenceBinding).values({
          factKind: "manualEntry",
          factId: manualId,
          eventKey: line.id,
          basis: "baseline",
          scopeKind: "purchaseEvent",
          scopeKey: first.id,
        });
      }),
    );
    await append(ctx.db, [
      evidenceRow(manualTransactionEvidence, {
        id: manualId,
        entity: "expense",
        userId: ctx.actor.userId,
        payload: {
          purchaseEvent: first.id,
          table: expenseRecords.name,
          naturalKey: owned!.naturalKey,
          values: {
            cost: "10000",
            purchaseId: line.purchaseId!,
            lineBasis: "allocation",
            economicRole: line.economicRole,
          },
        },
      }),
    ]);
    const scope = { kind: "purchaseEvent", key: first.id };
    await reconcileNow(ctx.db, [scope]);
    for (const proposal of await getDb(ctx.db).select().from(drift))
      expect(proposal.difference).toMatchObject({ disagreements: [] });
    await updateExpense(
      ctx.db,
      parseShortcodeFor("expense", line.shortcode),
      { cost: 110, spendingCategoryId: setup.advice.spendingCategoryId },
      ctx.actor,
    );
    const saved = (await ledgerRows()).expenses[0]!;
    expect(saved).toMatchObject({
      cost: 11000n,
      spendingCategoryId: expect.any(String),
    });
    expect(await getDb(ctx.db).select().from(drift)).toEqual([
      expect.objectContaining({
        scopeKind: "purchaseEvent",
        scopeKey: first.id,
        difference: expect.objectContaining({
          disagreements: [expect.any(String)],
        }),
      }),
    ]);
    await reconcileNow(ctx.db, [scope]);
    expect((await ledgerRows()).expenses[0]).toEqual(saved);
    expect(
      (await ledgerRows()).transactions.map((row) => row.amount).sort(),
    ).toEqual([4000n, 6000n]);
  });
  it("writes no ledger rows when a kernel baseline disagrees with a revised statement", async () => {
    const setup = await fixture("kernel-baseline");
    await applyKernelCharge(setup);
    const before = await ledgerRows();
    const [occurrence] = await getDb(ctx.db).select().from(sourceOccurrence);
    await getDb(ctx.db)
      .insert(evidenceBinding)
      .values([
        {
          factKind: "sourceOccurrence",
          factId: occurrence!.id,
          eventKey: before.transactions[0]!.id,
          basis: "baseline",
          scopeKind: "bankEvent",
          scopeKey: occurrence!.id,
        },
        {
          factKind: "statementObservation",
          factId: occurrence!.currentObservationId!,
          eventKey: before.purchases[0]!.id,
          basis: "baseline",
          scopeKind: "purchaseEvent",
          scopeKey: before.transactions[0]!.id,
        },
      ]);
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...setup.input,
        import: {
          ...setup.input.import,
          fingerprint: "synthetic-kernel-baseline-revision",
          observedAt: "2026-06-01T00:00:00Z",
        },
        rows: setup.input.rows.map((row) => ({ ...row, providerAmount: -50 })),
      }),
      ctx.actor,
    );
    const revisions = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const revision = revisions.find((row) => row.providerAmount === -5000n)!;
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({ currentObservationId: revision.id, reviewState: "ready" })
      .where(eq(sourceOccurrence.id, occurrence!.id));
    await emitWrites(ctx.db, {
      table: sourceOccurrence,
      ids: [occurrence!.id],
      columns: ["currentObservationId", "reviewState"],
    });
    const result = await reconcileNow(ctx.db, [
      { kind: "bankEvent", key: occurrence!.id },
      { kind: "purchaseEvent", key: before.transactions[0]!.id },
    ]);
    expect(result.some((outcome) => outcome.error)).toBe(false);
    expect(await ledgerRows()).toEqual(before);
    const proposals = await getDb(ctx.db).select().from(drift);
    expect(
      proposals.some(
        (row) =>
          row.scopeKind === "bankEvent" && row.scopeKey === occurrence!.id,
      ),
    ).toBe(true);
  });
  it.each([1, 8, 32])(
    "settles %i new statement charges through the kernel within its statement budget",
    async (count) => {
      const owner = await createRepoIdentity(ctx, "ledgerParty", {
        name: "Synthetic budget member",
        kind: "member",
      });
      const account = await createRepoIdentity(ctx, "financialAccount", {
        name: "Synthetic budget card",
        identity: { kind: "credit_card", network: "visa" },
        ledgerPartyId: owner.output.id,
      });
      const [budgetAccount] = await getDb(ctx.db)
        .select()
        .from(financialAccount)
        .where(eq(financialAccount.shortcode, account.output.id));
      const rowAccountId = budgetAccount!.id;
      let seededScopes: { kind: string; key: string }[] = [];
      if (count === 32) {
        const [seller] = await insertManyWithShortcode(ctx.db, "vendor", [
          { name: "Synthetic budget merchant 0" },
        ]);
        const historical = await withKernelApply(null, () =>
          insertManyWithShortcode(
            ctx.db,
            "purchase",
            Array.from({ length: 2048 }, (_, index) => ({
              vendorId: seller!.id,
              displayLabel: `Synthetic history ${index}`,
              date: shiftPlainDate("2024-01-01", -index),
            })),
          ),
        );
        const transactions = await withKernelApply(null, () =>
          insertManyWithShortcode(
            ctx.db,
            "financialTransaction",
            historical.map((row) => ({
              accountId: rowAccountId,
              kind: "purchase",
              status: "posted",
              amount: 1000n,
              transactionDate: row.date,
              postedDate: row.date,
              merchant: "Synthetic budget merchant 0",
            })),
          ),
        );
        await withKernelApply(null, async () => {
          await insertManyWithShortcode(
            ctx.db,
            "expense",
            historical.map((row) => ({
              purchaseId: row.id,
              name: "Synthetic settled history",
              cost: 1000n,
              date: "2024-01-01",
              economicRole: "vendor",
              lineKind: "principal",
              costType: "materials",
              trade: "other",
              future: false,
            })),
          );
          await getDb(ctx.db)
            .insert(financialTransactionAllocation)
            .values(
              historical.map((row, index) => ({
                purchaseId: row.id,
                transactionId: transactions[index]!.id,
                amountMinor: 1000n,
                confirmsMerchant: false,
              })),
            );
        });
        seededScopes = transactions.map((row) => ({
          kind: "purchaseEvent",
          key: row.id,
        }));
        await reconcileNow(ctx.db, [seededScopes[0]!]);
        await getDb(ctx.db)
          .execute(sql`INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
          SELECT 'purchaseEvent', historical.id, replace(dep.key, ${seededScopes[0]!.key}, historical.id)
          FROM unnest(${textArrayParam(seededScopes.slice(1).map((scope) => scope.key))}) historical(id)
          CROSS JOIN "ScopeDep" dep WHERE dep."scopeKind"='purchaseEvent' AND dep."scopeKey"=${seededScopes[0]!.key}
          ON CONFLICT DO NOTHING`);
      }
      const merchants = Array.from(
        { length: count },
        (_, index) => `Synthetic budget merchant ${index}`,
      );
      await insertManyWithShortcode(
        ctx.db,
        "vendor",
        merchants
          .filter((_, index) => count !== 32 || index !== 0)
          .map((name) => ({ name })),
      );
      await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            source: "monarch",
            label: "Synthetic kernel budget",
            fingerprint: `kernel-budget-${count}`,
            observedAt: "2026-05-05T00:00:00Z",
          },
          rows: merchants.map((merchant, index) => ({
            providerTransactionId: `synthetic-kernel-budget-${index}`,
            providerAccountId: "synthetic-budget-account",
            accountDescriptor: "Synthetic budget card",
            statementDate: "2026-05-04",
            providerAmount: -10,
            providerStatus: "posted",
            merchant,
            rawDescription: merchant,
            sourceCategory: "Groceries",
            rowPosition: index + 1,
          })),
        }),
        ctx.actor,
      );
      const occurrences = await getDb(ctx.db).select().from(sourceOccurrence);
      await decide(
        ctx.db,
        ctx.actor,
        occurrences.flatMap((row) => [
          {
            channel: "assignment",
            kind: "set",
            subject: `bank:${row.id}`,
            field: "accountId",
            value: account.output.id,
            scopes: [{ kind: "bankEvent", key: row.id }],
          },
          {
            channel: "assignment",
            kind: "set",
            subject: `bank:${row.id}`,
            field: "kind",
            value: "purchase",
            scopes: [{ kind: "bankEvent", key: row.id }],
          },
        ]),
      );
      const kernel = await productionKernel();
      // Capture wakes even when the runner consumes them before this journey ends.
      await getDb(ctx.db).execute(sql`CREATE TABLE "SyntheticKernelWake" (
        kind text NOT NULL, key text NOT NULL, raises int NOT NULL DEFAULT 1,
        PRIMARY KEY (kind, key)
      )`);
      await getDb(ctx.db)
        .execute(sql`CREATE FUNCTION synthetic_kernel_wake() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "SyntheticKernelWake" (kind, key) VALUES (NEW."scopeKind", NEW."scopeKey")
        ON CONFLICT (kind, key) DO UPDATE SET raises = "SyntheticKernelWake".raises + 1;
        RETURN NEW;
      END $$`);
      await getDb(ctx.db)
        .execute(sql`CREATE TRIGGER synthetic_kernel_wake AFTER INSERT OR UPDATE OF seq ON "ScopeDirty"
      FOR EACH ROW EXECUTE FUNCTION synthetic_kernel_wake()`);
      const measured = await withDatabaseOperationMetrics(async (metrics) => {
        if (count === 32) {
          await reconcileNow(
            ctx.db,
            occurrences.map((row) => ({ kind: "bankEvent", key: row.id })),
          );
          const dirty = await getDb(ctx.db).execute<{
            n: number;
            historical: number;
          }>(
            sql`SELECT count(*)::int n, count(*) FILTER (WHERE "scopeKey" = ANY(${textArrayParam(seededScopes.map((scope) => scope.key))}))::int historical FROM "ScopeDirty" WHERE "scopeKind"='purchaseEvent'`,
          );
          if (
            dirty.rows.length !== 1 ||
            dirty.rows[0]!.n !== 32 ||
            dirty.rows[0]!.historical !== 0
          )
            throw new Error(
              `Unexpected statement fanout: ${JSON.stringify(dirty.rows)}`,
            );
          console.log(
            "statement-kernel-fanout",
            JSON.stringify({
              householdPurchases: 2048,
              page: 32,
              dirtied: dirty.rows[0]!.n,
              historicalDirtied: dirty.rows[0]!.historical,
            }),
          );
        }
        await expectStatementBudget(
          () =>
            withDatabaseOperationPhase("fence", () =>
              Promise.all([
                kernel.run(ctx.db, { budgetMs: 20_000 }),
                householdWrite(ctx.db, async (tx) => {
                  await getDb(tx)
                    .update(financialAccount)
                    .set({ notes: "Synthetic concurrent member edit" })
                    .where(eq(financialAccount.shortcode, account.output.id));
                }),
              ]),
            ),
          { statements: 150, parameters: 128 },
        );
        expect(
          Object.values(metrics.queryCountByPhase).reduce(
            (sum, value) => sum + value,
            0,
          ),
        ).toBe(metrics.queryCount);
        expect(
          metrics.queryCount,
          "complete statement settlement journey",
        ).toBeLessThanOrEqual(150);
        expect(metrics.queryCountByPhase.load).toBeLessThanOrEqual(48);
        expect(metrics.queryCountByPhase.audit).toBeLessThanOrEqual(2);
        return {
          charges: count,
          statements: metrics.queryCount,
          parameters: metrics.queryMaxParameterCount,
          phases: metrics.queryCountByPhase,
        };
      });
      console.log("statement-kernel-budget", JSON.stringify(measured));
      const settledFanout = await getDb(ctx.db).execute<{
        kind: string;
        n: number;
        historical: number;
        raises: number;
      }>(
        sql`SELECT kind, count(*)::int n, sum(raises)::int raises, count(*) FILTER (WHERE key=ANY(${textArrayParam(seededScopes.map((scope) => scope.key))}))::int historical FROM "SyntheticKernelWake" GROUP BY kind`,
      );
      expect(
        settledFanout.rows.reduce((sum, row) => sum + row.historical, 0),
      ).toBe(0);
      console.log(
        "statement-kernel-settled-fanout",
        JSON.stringify({ charges: count, woken: settledFanout.rows }),
      );
      expect(
        settledFanout.rows.find((row) => row.kind === "purchaseEvent")?.n,
      ).toBe(count);
      await getDb(ctx.db).execute(
        sql`DROP TRIGGER synthetic_kernel_wake ON "ScopeDirty"`,
      );
      await getDb(ctx.db).execute(sql`DROP FUNCTION synthetic_kernel_wake()`);
      await getDb(ctx.db).execute(sql`DROP TABLE "SyntheticKernelWake"`);
      const totals = await getDb(ctx.db).execute<{
        purchases: number;
        expenses: number;
        allocations: number;
        bindings: number;
        cost: string;
        allocated: string;
      }>(sql`SELECT
      (SELECT count(*)::int FROM "Purchase" WHERE "deletedAt" IS NULL) purchases,
      (SELECT count(*)::int FROM "Expense" WHERE "deletedAt" IS NULL) expenses,
      (SELECT count(*)::int FROM "FinancialTransactionAllocation" WHERE "deletedAt" IS NULL) allocations,
      (SELECT count(*)::int FROM "EvidenceBinding" WHERE "factKind"=${"sourceOccurrence"}) bindings,
      (SELECT sum("costMinor")::text FROM "Expense" WHERE "deletedAt" IS NULL) cost,
      (SELECT sum("amountMinor")::text FROM "FinancialTransactionAllocation" WHERE "deletedAt" IS NULL) allocated`);
      expect(totals.rows[0]).toEqual({
        purchases: count + seededScopes.length,
        expenses: count + seededScopes.length,
        allocations: count + seededScopes.length,
        bindings: count,
        cost: String((count + seededScopes.length) * 1000),
        allocated: String((count + seededScopes.length) * 1000),
      });
    },
  );
});
