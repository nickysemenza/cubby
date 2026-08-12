import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getDb } from "./database-helpers";
import { createFinancialAccount } from "./financial-account";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";
import {
  getStatementRowSummary,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "./statement-row";
import { statementRowExternalId } from "./statement-row-identity";

const importInput = (overrides: Record<string, unknown> = {}) => ({
  source: "monarch",
  label: "monarch-2026-08.csv",
  fingerprint: "fp-monarch-1",
  dateKind: "transaction" as const,
  rowCountDeclared: 2,
  notes: null,
  ...overrides,
});

const rowInput = (overrides: Record<string, unknown> = {}) => ({
  accountDescriptor: "Blue Cash Preferred (...1005)",
  statementDate: "2026-05-04",
  providerAmount: -128.5,
  merchant: "Acme Supply",
  rawDescription: "ACME SUPPLY CO SAN FRANCISCO CA",
  sourceCategory: "Home",
  providerStatus: "posted" as const,
  providerNotes: null,
  ...overrides,
});

const record = (
  db: Parameters<typeof recordStatementRows>[0],
  actor: Parameters<typeof recordStatementRows>[2],
  rows: Record<string, unknown>[],
  importOverrides: Record<string, unknown> = {},
) =>
  recordStatementRows(
    db,
    recordStatementRowsInput.parse({
      import: importInput(importOverrides),
      rows,
    }),
    actor,
  );

describe("statement row ledger", () => {
  const ctx = withTestDb();

  it("records provider rows verbatim and is idempotent on re-ingest", async () => {
    const first = await record(ctx.db, ctx.actor, [
      rowInput(),
      rowInput({
        statementDate: "2026-05-06",
        providerAmount: 42.75,
        rawDescription: "ACME SUPPLY CO REFUND",
      }),
    ]);
    expect(first).toMatchObject({
      batchCreated: true,
      inserted: 2,
      unchanged: 0,
      rowCountStored: 2,
    });

    // Re-submitting the same export must change nothing — this is what makes a
    // full-history re-ingest cheap rather than a duplicate-generating event.
    const second = await record(ctx.db, ctx.actor, [
      rowInput(),
      rowInput({
        statementDate: "2026-05-06",
        providerAmount: 42.75,
        rawDescription: "ACME SUPPLY CO REFUND",
      }),
    ]);
    expect(second).toMatchObject({
      batchCreated: false,
      inserted: 0,
      unchanged: 2,
      rowCountStored: 2,
    });

    const listed = await listStatementRows(ctx.db, {});
    expect(listed.count).toBe(2);
    const charge = listed.data.find((row) => row.providerAmount === -128.5);
    // Provider sign preserved, Cubby sign normalized to outflow-positive.
    expect(charge).toMatchObject({
      amount: 128.5,
      providerAmount: -128.5,
      matchState: "unmatched",
      transactionId: null,
      disposition: "open",
    });
    expect(charge?.externalId).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("derives match state from sourceRefs, without storing it", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-match",
    });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    expect(row?.matchState).toBe("unmatched");

    const account = (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name: "Blue Cash Preferred",
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "amex",
            last4: "1005",
          },
          sourceAliases: [],
        }),
        ctx.actor,
      )
    ).output;

    const transaction = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.id,
          kind: "purchase",
          status: "posted",
          amount: 128.5,
          postedDate: "2026-05-04",
          sourceRefs: [{ source: row!.source, externalId: row!.externalId }],
        }),
        ctx.actor,
      )
    ).output;

    // No write to StatementRow: appending the ref on the transaction side is
    // what flips the row, which is why triage needs no new mutation surface.
    const afterMatch = (await listStatementRows(ctx.db, {})).data[0];
    expect(afterMatch).toMatchObject({
      matchState: "matched",
      transactionId: transaction.id,
    });

    // A soft-deleted transaction is not evidence.
    await deleteFinancialTransactions(ctx.db, [transaction.id], ctx.actor);
    const afterDelete = (await listStatementRows(ctx.db, {})).data[0];
    expect(afterDelete).toMatchObject({
      matchState: "unmatched",
      transactionId: null,
    });
  });

  it("reports one transaction carrying two providers' refs exactly once", async () => {
    const monarch = await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-two-refs-monarch",
    });
    expect(monarch.inserted).toBe(1);
    // The same charge as a second provider dates it — different hash, own row.
    const copilot = await record(
      ctx.db,
      ctx.actor,
      [rowInput({ statementDate: "2026-05-06" })],
      { source: "copilot", fingerprint: "fp-two-refs-copilot" },
    );
    expect(copilot.inserted).toBe(1);

    const rows = (await listStatementRows(ctx.db, {})).data;
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a!.externalId).not.toBe(b!.externalId);

    const account = (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name: "Shared Card",
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "amex",
            last4: "1005",
          },
          sourceAliases: [],
        }),
        ctx.actor,
      )
    ).output;
    await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 128.5,
        postedDate: "2026-05-04",
        sourceRefs: rows.map((row) => ({
          source: row.source,
          externalId: row.externalId,
        })),
      }),
      ctx.actor,
    );

    // One transaction, two matching refs: each row must appear once. Without
    // the global (source, externalId) uniqueness this join relies on, the
    // correlated lookup would be a fan-out.
    const matched = await listStatementRows(ctx.db, { matchState: "matched" });
    expect(matched.count).toBe(2);
    expect(matched.data).toHaveLength(2);
    expect(new Set(matched.data.map((row) => row.transactionId)).size).toBe(1);
  });

  it("drops ignored and superseded rows out of the unmatched worklist", async () => {
    const pending = rowInput({
      providerStatus: "pending",
      statementDate: "2026-05-04",
    });
    const posted = rowInput({
      providerStatus: "posted",
      statementDate: "2026-05-07",
    });
    const noise = rowInput({
      providerAmount: -9.99,
      statementDate: "2026-05-09",
      rawDescription: "COFFEE SHOP",
    });
    await record(ctx.db, ctx.actor, [pending, posted, noise], {
      fingerprint: "fp-worklist",
      rowCountDeclared: 3,
    });

    expect(
      (await listStatementRows(ctx.db, { matchState: "unmatched" })).count,
    ).toBe(3);

    const rows = (await listStatementRows(ctx.db, {})).data;
    const pendingRow = rows.find((row) => row.statementDate === "2026-05-04")!;
    const postedRow = rows.find((row) => row.statementDate === "2026-05-07")!;
    const noiseRow = rows.find((row) => row.rawDescription === "COFFEE SHOP")!;

    // A pending row that posts later is a different row; the link is written,
    // never inferred, and keeps the evidence that the pending row existed.
    await updateStatementRows(
      ctx.db,
      [pendingRow.externalId],
      "monarch",
      { supersededByExternalId: postedRow.externalId },
      ctx.actor,
    );
    await updateStatementRows(
      ctx.db,
      [noiseRow.externalId],
      "monarch",
      {
        disposition: "ignored",
        dispositionReason: "not_modeled",
        dispositionNote: "Consumer spend; Cubby does not model it.",
      },
      ctx.actor,
    );

    const worklist = await listStatementRows(ctx.db, {
      matchState: "unmatched",
    });
    expect(worklist.count).toBe(1);
    expect(worklist.data[0]?.externalId).toBe(postedRow.externalId);

    const superseded = await listStatementRows(ctx.db, {
      matchState: "superseded",
    });
    expect(superseded.data[0]).toMatchObject({
      externalId: pendingRow.externalId,
      supersededBy: postedRow.externalId,
    });

    const summary = await getStatementRowSummary(ctx.db, {});
    expect(summary).toMatchObject({
      total: 3,
      unmatched: 1,
      ignored: 1,
      superseded: 1,
      matched: 0,
    });
  });

  it("rejects an ignore without reasoning, and a non-slug source", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], { fingerprint: "fp-checks" });
    const [row] = (await listStatementRows(ctx.db, {})).data;

    // The CHECK, not application code, is what makes a reasonless ignore
    // impossible — dispositions carry their reasoning or do not exist.
    await expect(
      updateStatementRows(
        ctx.db,
        [row!.externalId],
        "monarch",
        { disposition: "ignored" },
        ctx.actor,
      ),
    ).rejects.toThrow();

    await expect(
      getDb(ctx.db).execute(sql`
        INSERT INTO "StatementImport" ("source", "label", "fingerprint")
        VALUES ('Monarch', 'bad-slug.csv', 'fp-bad-slug')
      `),
    ).rejects.toThrow();
  });

  it("excludes soft-deleted rows from every read", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-deleted",
    });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    await getDb(ctx.db).execute(sql`
      UPDATE "StatementRow" SET "deletedAt" = now() WHERE "externalId" = ${row!.externalId}
    `);

    expect((await listStatementRows(ctx.db, {})).count).toBe(0);
    expect((await getStatementRowSummary(ctx.db, {})).total).toBe(0);

    // The unique index is partial, so the same row can be recorded again once
    // the earlier one is out of the way.
    const again = await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-deleted-2",
    });
    expect(again.inserted).toBe(1);
  });

  it("narrows to nothing for an unknown account code rather than widening", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-account",
    });
    const unknown = await listStatementRows(ctx.db, { accountId: "FAC-ZZZZ" });
    expect(unknown.count).toBe(0);
  });

  it("derives externalId server-side, matching the shared identity function", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], { fingerprint: "fp-hash" });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    // The stored columns reproduce the hash payload exactly, so the ledger can
    // audit its own identity function rather than trusting an opaque token.
    await expect(
      statementRowExternalId({
        source: row!.source,
        account: row!.accountDescriptor,
        date: row!.statementDate,
        amount: row!.providerAmount,
        originalStatement: row!.rawDescription,
      }),
    ).resolves.toBe(row!.externalId);
  });

  it("keeps a matched row matched after an unrelated ref is appended", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], { fingerprint: "fp-append" });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    const account = (
      await createFinancialAccount(
        ctx.db,
        financialAccountCreateInput.parse({
          name: "Append Card",
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "amex",
            last4: "1005",
          },
          sourceAliases: [],
        }),
        ctx.actor,
      )
    ).output;
    const transaction = (
      await createFinancialTransaction(
        ctx.db,
        financialTransactionCreateInput.parse({
          accountId: account.id,
          kind: "purchase",
          status: "posted",
          amount: 128.5,
          postedDate: "2026-05-04",
          sourceRefs: [{ source: "gmail", externalId: "receipt-1" }],
        }),
        ctx.actor,
      )
    ).output;
    expect((await listStatementRows(ctx.db, {})).data[0]?.matchState).toBe(
      "unmatched",
    );

    // Read-merge-write on sourceRefs is the documented remediation, and it is
    // the whole burn-down loop: append the ref, the row flips on next read.
    await updateFinancialTransaction(
      ctx.db,
      transaction.id,
      {
        sourceRefs: [
          { source: "gmail", externalId: "receipt-1" },
          { source: row!.source, externalId: row!.externalId },
        ],
      },
      ctx.actor,
    );
    expect((await listStatementRows(ctx.db, {})).data[0]).toMatchObject({
      matchState: "matched",
      transactionId: transaction.id,
    });
  });
});
