import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import {
  recordStatementRowsInput,
  type StatementImportInput,
  type StatementRowInput,
} from "@cubby/schemas/statement-row";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  commitStatementCsv,
  previewStatementCsv,
} from "~/server/statement-csv-import";

import { getDb } from "./database-helpers";
import { createFinancialAccount } from "./financial-account";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
} from "./financial-transaction";
import {
  deleteStatementRows,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "./statement-row";
import { statementRowExternalId } from "./statement-row-identity";

const importInput = (
  overrides: Partial<StatementImportInput> = {},
): StatementImportInput => ({
  source: "monarch",
  label: "monarch-2026-08.csv",
  fingerprint: "fp-monarch-1",
  dateKind: "transaction" as const,
  rowCountDeclared: 2,
  notes: null,
  ...overrides,
});

const rowInput = (
  overrides: Partial<StatementRowInput> = {},
): StatementRowInput => ({
  accountDescriptor: "Test Card (...4242)",
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
  rows: StatementRowInput[],
  importOverrides: Partial<StatementImportInput> = {},
  dryRun = false,
) =>
  recordStatementRows(
    db,
    recordStatementRowsInput.parse({
      import: importInput(importOverrides),
      rows,
      dryRun,
    }),
    actor,
  );

describe("statement row ledger", () => {
  const ctx = withTestDb();

  it("previews, confirms and safely replays a synthetic CSV through the native intake contract", async () => {
    await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "Test Card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        cardNumbers: [
          {
            last4: "4242",
            kind: "primary",
            validFrom: null,
            validTo: null,
            note: null,
          },
        ],
        sourceAliases: [
          {
            source: "monarch",
            alias: "Test Card (...4242)",
            externalAccountId: null,
          },
        ],
      }),
      ctx.actor,
    );
    const file = {
      fileName: "synthetic-statement.csv",
      text: "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id\n2026-08-16,ForgeWear,Clothing,Test Card (...4242),FORGEWEAR ORDER,, -42.50,row-1\n",
    };
    const preview = await previewStatementCsv(ctx.db, ctx.actor, file);
    expect(preview.preview?.rows[0]).toMatchObject({
      status: "ready_to_create",
    });
    expect((await listStatementRows(ctx.db, {})).count).toBe(0);

    const first = await commitStatementCsv(ctx.db, ctx.actor, {
      ...file,
      selected: [{ key: "1", kind: "purchase" }],
    });
    expect(first).toMatchObject({ transactions: 1, evidence: 1 });
    const replay = await commitStatementCsv(ctx.db, ctx.actor, {
      ...file,
      selected: [{ key: "1", kind: "purchase" }],
    });
    expect(replay).toMatchObject({ transactions: 0, evidence: 0 });
    expect((await listStatementRows(ctx.db, {})).count).toBe(1);
  });

  it("pages a long native CSV preview so later charges can be reviewed", async () => {
    const file = {
      fileName: "long-synthetic-statement.csv",
      text:
        "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id\n" +
        Array.from(
          { length: 201 },
          (_, index) =>
            `2026-08-16,Shop ${index},Home,Unknown Card,ORDER ${index},,-1.00,row-${index}\n`,
        ).join(""),
    };
    const first = await previewStatementCsv(ctx.db, ctx.actor, file);
    const second = await previewStatementCsv(ctx.db, ctx.actor, {
      ...file,
      previewOffset: 200,
    });
    expect(first.preview?.rows).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    expect(second.preview?.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.preview?.rows[0]?.proposed.merchant).toBe("Shop 200");
  });

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
    expect(charge).toMatchObject({
      amount: 128.5,
      providerAmount: -128.5,
      matchState: "unmatched",
      transactionId: null,
      disposition: "open",
    });
    expect(charge?.externalId).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("reports what a dryRun would insert and writes nothing", async () => {
    const rows = [
      rowInput({
        statementDate: "2026-05-11",
        providerAmount: -77.77,
        rawDescription: "DRY RUN ROW ONE",
      }),
      rowInput({
        statementDate: "2026-05-12",
        providerAmount: -88.88,
        rawDescription: "DRY RUN ROW TWO",
      }),
    ];
    const preview = await record(
      ctx.db,
      ctx.actor,
      rows,
      { fingerprint: "fp-dry", rowCountDeclared: 2 },
      true,
    );
    expect(preview).toMatchObject({
      batchId: null,
      batchCreated: false,
      dryRun: true,
      inserted: 2,
      unchanged: 0,
      rowCountStored: 0,
    });
    // No batch, no rows: the preview must be free of side effects, or it is
    // just an ingest that lies about what it did.
    expect((await listStatementImports(ctx.db)).data).toHaveLength(0);
    expect((await listStatementRows(ctx.db, {})).count).toBe(0);

    const written = await record(ctx.db, ctx.actor, rows, {
      fingerprint: "fp-dry",
      rowCountDeclared: 2,
    });
    expect(written).toMatchObject({ dryRun: false, inserted: 2 });

    const replay = await record(
      ctx.db,
      ctx.actor,
      rows,
      { fingerprint: "fp-dry", rowCountDeclared: 2 },
      true,
    );
    expect(replay).toMatchObject({
      dryRun: true,
      inserted: 0,
      unchanged: 2,
      alreadyInThisBatch: 2,
      rowCountStored: 2,
    });
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
          name: "Test Card",
          identity: { kind: "credit_card", issuer: null, network: "amex" },
          cardNumbers: [
            {
              last4: "4242",
              kind: "primary",
              validFrom: null,
              validTo: null,
              note: null,
            },
          ],
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
          identity: { kind: "credit_card", issuer: null, network: "amex" },
          cardNumbers: [
            {
              last4: "4242",
              kind: "primary",
              validFrom: null,
              validTo: null,
              note: null,
            },
          ],
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

  it("rejects an ignore without reasoning, and a non-slug source", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], { fingerprint: "fp-checks" });
    const [row] = (await listStatementRows(ctx.db, {})).data;

    // The CHECK, not application code, is what makes a reasonless ignore
    // impossible — dispositions carry their reasoning or do not exist.
    await expect(
      updateStatementRows(
        ctx.db,
        {
          selector: { source: "monarch", externalIds: [row!.externalId] },
          data: { disposition: "ignored" },
        },
        ctx.actor,
      ),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();

    await expect(
      getDb(ctx.db).execute(sql`
        INSERT INTO "StatementImport" ("source", "label", "fingerprint")
        VALUES ('Monarch', 'bad-slug.csv', 'fp-bad-slug')
      `),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("refuses a bulk write whose filter restricts nothing", async () => {
    await record(
      ctx.db,
      ctx.actor,
      [rowInput(), rowInput({ providerAmount: -5 })],
      {
        fingerprint: "fp-empty-filter",
      },
    );
    const before = await listStatementRows(ctx.db, {});
    expect(before.count).toBe(2);

    // `""` is *supplied*, so a `!== undefined` check passes it — but the filter
    // builder skips falsy strings, leaving only `notDeleted`. Addressing every
    // row is never what a bulk disposition meant.
    for (const filter of [{ search: "" }, { source: "" }] as const) {
      await expect(
        updateStatementRows(
          ctx.db,
          {
            selector: { filter },
            data: {
              disposition: "ignored",
              dispositionReason: "not_modeled",
              dispositionNote: "should never apply",
            },
          },
          ctx.actor,
        ),
        // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
      ).rejects.toThrow();
      await expect(
        deleteStatementRows(ctx.db, { filter }, ctx.actor),
        // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
      ).rejects.toThrow();
    }

    const after = await listStatementRows(ctx.db, {});
    expect(after.count).toBe(2);
    expect(after.data.every((row) => row.disposition === "open")).toBe(true);
  });

  it("warns when a batch looks submitted with the wrong sign", async () => {
    const wrongWay = Array.from({ length: 24 }, (_, i) =>
      rowInput({ providerAmount: 10 + i, rawDescription: `POSITIVE ROW ${i}` }),
    );
    const flagged = await record(ctx.db, ctx.actor, wrongWay, {
      fingerprint: "fp-sign",
    });
    expect(flagged.signWarning).toContain("24 of 24");

    const fine = await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-sign-ok",
    });
    expect(fine.signWarning).toBeNull();
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
});
