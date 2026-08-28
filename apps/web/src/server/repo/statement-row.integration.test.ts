import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import {
  findStatementRowDriftInput,
  recordStatementRowsInput,
} from "@cubby/schemas/statement-row";
import { testShortcode } from "@cubby/schemas/testing";
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
  deleteStatementRows,
  findStatementRowDrift,
  getStatementRowSummary,
  listStatementImports,
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
  rows: Record<string, unknown>[],
  importOverrides: Record<string, unknown> = {},
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

  it("splits unchanged into the three states it used to conflate", async () => {
    const other = rowInput({
      statementDate: "2026-05-09",
      providerAmount: -11.11,
      rawDescription: "OTHER BATCH ROW",
    });
    await record(ctx.db, ctx.actor, [other], {
      fingerprint: "fp-breakdown-other",
      rowCountDeclared: 1,
    });

    const result = await record(
      ctx.db,
      ctx.actor,
      [rowInput(), rowInput(), other],
      { fingerprint: "fp-breakdown", rowCountDeclared: 4 },
    );
    expect(result).toMatchObject({
      dryRun: false,
      inserted: 1,
      unchanged: 2,
      alreadyInThisBatch: 0,
      alreadyInAnotherBatch: 1,
      indistinguishableDuplicates: 1,
      rowsOmitted: 1,
    });

    const again = await record(ctx.db, ctx.actor, [rowInput()], {
      fingerprint: "fp-breakdown",
      rowCountDeclared: 1,
    });
    expect(again).toMatchObject({
      inserted: 0,
      unchanged: 1,
      alreadyInThisBatch: 1,
      alreadyInAnotherBatch: 0,
      indistinguishableDuplicates: 0,
      rowsOmitted: 0,
    });
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

  it("finds a charge re-recorded under a firmed-up descriptor", async () => {
    const shared = { statementDate: "2026-05-20", providerAmount: -63.42 };
    await record(
      ctx.db,
      ctx.actor,
      [
        rowInput({ ...shared, rawDescription: "AMAZON MKTPLACE PMTS" }),
        // Same day, same card, DIFFERENT amount — not drift, and the sweep
        // must not report it.
        rowInput({
          statementDate: "2026-05-20",
          providerAmount: -9.99,
          rawDescription: "UNRELATED SAME DAY CHARGE",
        }),
        rowInput({
          statementDate: "2026-05-21",
          providerAmount: -4.5,
          rawDescription: "BLUE BOTTLE COFFEE 1",
        }),
        rowInput({
          statementDate: "2026-05-21",
          providerAmount: -4.5,
          rawDescription: "BLUE BOTTLE COFFEE 2",
        }),
      ],
      { fingerprint: "fp-drift-first", rowCountDeclared: 4 },
    );
    // The later export firms the descriptor up, so the identity hash — which
    // covers rawDescription — mints a SECOND row for money already recorded.
    await record(
      ctx.db,
      ctx.actor,
      [rowInput({ ...shared, rawDescription: "AMAZON MKTPL*XD8AR9RG3" })],
      { fingerprint: "fp-drift-second", rowCountDeclared: 1 },
    );

    const found = await findStatementRowDrift(
      ctx.db,
      findStatementRowDriftInput.parse({}),
    );
    expect(found.truncated).toBe(false);
    // The same-batch coffee pair is excluded by default — on the production
    // ledger that class is 240 groups against 0 real findings.
    expect(found.candidates).toHaveLength(1);
    const [candidate] = found.candidates;
    expect(candidate).toMatchObject({
      source: "monarch",
      statementDate: "2026-05-20",
      providerAmount: -63.42,
      crossBatch: true,
    });

    const withSameBatch = await findStatementRowDrift(
      ctx.db,
      findStatementRowDriftInput.parse({ includeSameBatch: true }),
    );
    expect(withSameBatch.candidates).toHaveLength(2);
    // Cross-batch first, so a bounded sweep spends its limit on drift.
    expect(withSameBatch.candidates.map((row) => row.crossBatch)).toEqual([
      true,
      false,
    ]);
    expect(candidate?.rows.map((row) => row.rawDescription)).toEqual([
      "AMAZON MKTPLACE PMTS",
      "AMAZON MKTPL*XD8AR9RG3",
    ]);
    expect(candidate?.rows.map((row) => row.importFingerprint)).toEqual([
      "fp-drift-first",
      "fp-drift-second",
    ]);

    await updateStatementRows(
      ctx.db,
      {
        selector: {
          source: "monarch",
          externalIds: [candidate!.rows[0]!.externalId],
        },
        data: { supersededByExternalId: candidate!.rows[1]!.externalId },
      },
      ctx.actor,
    );
    expect(
      (
        await findStatementRowDrift(
          ctx.db,
          findStatementRowDriftInput.parse({}),
        )
      ).candidates,
    ).toHaveLength(0);
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
          identity: {
            kind: "credit_card",
            issuer: null,
            network: "amex",
            last4: "4242",
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
            last4: "4242",
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
      {
        selector: { source: "monarch", externalIds: [pendingRow.externalId] },
        data: { supersededByExternalId: postedRow.externalId },
      },
      ctx.actor,
    );
    await updateStatementRows(
      ctx.db,
      {
        selector: { source: "monarch", externalIds: [noiseRow.externalId] },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Consumer spend; Cubby does not model it.",
        },
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

  it("applies a bulk write that genuinely restricts", async () => {
    await record(
      ctx.db,
      ctx.actor,
      [rowInput({ rawDescription: "COFFEE SHOP" }), rowInput()],
      { fingerprint: "fp-bulk-ok" },
    );
    const result = await updateStatementRows(
      ctx.db,
      {
        selector: { filter: { search: "COFFEE" } },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Consumer spend.",
        },
      },
      ctx.actor,
    );
    expect(result.affected).toBe(1);
    expect(
      (await listStatementRows(ctx.db, { disposition: "ignored" })).count,
    ).toBe(1);
  });

  it("filters by the provider's own category, and bulk-dispositions by it", async () => {
    await record(
      ctx.db,
      ctx.actor,
      [
        rowInput({
          sourceCategory: "Restaurants & Bars",
          rawDescription: "A CAFE",
        }),
        rowInput({
          sourceCategory: "Restaurants & Bars",
          rawDescription: "B CAFE",
          providerAmount: -22,
        }),
        rowInput({
          sourceCategory: "Home Improvement",
          rawDescription: "A HARDWARE STORE",
        }),
      ],
      { fingerprint: "fp-category" },
    );

    expect(
      (
        await listStatementRows(ctx.db, {
          sourceCategory: "Restaurants & Bars",
        })
      ).count,
    ).toBe(2);

    // The lever the backlog actually needs: the provider already classified the
    // spend, so taking a whole category off the worklist is one filtered write.
    const swept = await updateStatementRows(
      ctx.db,
      {
        selector: { filter: { sourceCategory: "Restaurants & Bars" } },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Consumer spend; Cubby does not model it.",
        },
      },
      ctx.actor,
    );
    expect(swept.affected).toBe(2);

    const remaining = await listStatementRows(ctx.db, {
      matchState: "unmatched",
    });
    expect(remaining.count).toBe(1);
    expect(remaining.data[0]?.sourceCategory).toBe("Home Improvement");
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
    const unknown = await listStatementRows(ctx.db, {
      accountId: testShortcode("financialAccount", "FAC-ZZZZ"),
    });
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
            last4: "4242",
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
