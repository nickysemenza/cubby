import {
  recordStatementRowsInput,
  type StatementImportInput,
  type StatementRowInput,
} from "@cubby/schemas/statement-row";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  commitStatementCsv,
  previewStatementCsv,
} from "~/server/statement-csv-import";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";

import { getDb } from "./database-helpers";
import {
  deleteStatementRows,
  listStatementImports,
  listStatementRows,
  recordStatementRows,
  updateStatementRows,
} from "./statement-row";
import {
  statementRowExternalId,
  statementRowOccurrenceId,
} from "./statement-row-identity";

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

type UnpositionedRow = Omit<StatementRowInput, "rowPosition">;

const rowInput = (
  overrides: Partial<UnpositionedRow> = {},
): UnpositionedRow => ({
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
  rows: UnpositionedRow[],
  importOverrides: Partial<StatementImportInput> = {},
  dryRun = false,
) =>
  recordStatementRows(
    db,
    recordStatementRowsInput.parse({
      import: importInput(importOverrides),
      rows: rows.map((row, index) => ({ ...row, rowPosition: index + 1 })),
      dryRun,
    }),
    actor,
  );

describe("statement row ledger", () => {
  const ctx = withTestDb();

  // This exercises the real PostgreSQL identity/ref constraints and shared
  // web/native CSV writer; a browser cannot expose duplicate ref ownership.
  it("retains identical and zero CSV occurrences, then reviews date/provider drift without another charge", async () => {
    await createRepoEntity(ctx, "financialAccount", {
      name: "Occurrence card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Occurrence Visa",
          externalAccountId: null,
        },
        { source: "mint", alias: "Occurrence Visa", externalAccountId: null },
      ],
    });
    const header =
      "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id";
    const file = {
      fileName: "occurrences.csv",
      text: `${header}\n2026-08-16,Synthetic Cafe,Food,Occurrence Visa,CAFE,,-4.50,one\n2026-08-16,Synthetic Cafe,Food,Occurrence Visa,CAFE,,-4.50,two\n2026-08-16,Synthetic Cafe,Food,Occurrence Visa,ZERO,,0,zero`,
    };
    const preview = await previewStatementCsv(ctx.db, ctx.actor, file);
    expect(preview.totalRows).toBe(3);
    expect(preview.preview?.rows.map((row) => row.status)).toEqual([
      "ready_to_create",
      "ready_to_create",
    ]);
    const committed = await commitStatementCsv(ctx.db, ctx.actor, {
      ...file,
      selected: [
        { key: "1", kind: "purchase" },
        { key: "2", kind: "purchase" },
      ],
    });
    expect(committed).toMatchObject({ transactions: 2, evidence: 3 });
    const savedOccurrences = await getDb(ctx.db).execute(sql`
      SELECT "externalId", "accountId", "updatedAt", xmin::text AS version
      FROM "StatementRow" ORDER BY "externalId"
    `);
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, {
        ...file,
        selected: [
          { key: "1", kind: "purchase" },
          { key: "2", kind: "purchase" },
        ],
      }),
    ).toMatchObject({ transactions: 0, evidence: 0 });
    // Exact-file retry must preserve both observation metadata and the row's
    // MVCC version; unchanged economic totals alone would miss a hidden UPDATE.
    expect(
      (
        await getDb(ctx.db).execute(sql`
        SELECT "externalId", "accountId", "updatedAt", xmin::text AS version
        FROM "StatementRow" ORDER BY "externalId"
      `)
      ).rows,
    ).toEqual(savedOccurrences.rows);
    const drift = {
      fileName: "drift.csv",
      text: `${header}\n2026-08-18,Synthetic Cafe,Food,Occurrence Visa,CAFE,,-4.50,one`,
    };
    const driftPreview = await previewStatementCsv(ctx.db, ctx.actor, drift);
    const candidate = driftPreview.preview?.rows[0];
    expect(candidate?.status).toBe("possible_existing");
    expect(candidate?.existingTransactionIds).toHaveLength(1);
    await expect(
      commitStatementCsv(ctx.db, ctx.actor, {
        ...drift,
        selected: [{ key: "1", kind: "purchase" }],
      }),
    ).rejects.toThrow("needs review");
    const transactionId = candidate?.existingTransactionIds[0];
    if (!transactionId) throw new Error("Expected stable-provider candidate");
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, {
        ...drift,
        selected: [{ key: "1", transactionId }],
      }),
    ).toMatchObject({ transactions: 0, attached: 1, evidence: 1 });
    expect(
      (await previewStatementCsv(ctx.db, ctx.actor, drift)).preview?.rows[0]
        ?.status,
    ).toBe("already_recorded");
    const mint = {
      fileName: "mint-observation.csv",
      text: "Date,Description,Original Description,Amount,Transaction Type,Category,Account Name\n2026-08-17,Synthetic Cafe,CAFE,4.50,debit,Food,Occurrence Visa",
    };
    const mintPreview = await previewStatementCsv(ctx.db, ctx.actor, mint);
    expect(mintPreview.preview?.rows[0]?.status).toBe("possible_existing");
    expect(mintPreview.preview?.rows[0]?.existingTransactionIds).toHaveLength(
      2,
    );
    await expect(
      commitStatementCsv(ctx.db, ctx.actor, {
        ...mint,
        selected: [{ key: "1", kind: "purchase" }],
      }),
    ).rejects.toThrow("needs review");
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, {
        ...mint,
        selected: [{ key: "1", transactionId }],
      }),
    ).toMatchObject({ transactions: 0, attached: 1 });
  });

  // Regression: two cumulative exports both recorded the same charge as open
  // rows, both previews offered it as ready_to_create, and settling both
  // minted duplicate transactions.
  it("settles each charge once across overlapping cumulative exports", async () => {
    await createRepoEntity(ctx, "financialAccount", {
      name: "Overlap card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      sourceAliases: [
        { source: "monarch", alias: "Overlap Visa", externalAccountId: null },
      ],
    });
    const header =
      "Date,Merchant,Category,Account,Original Statement,Notes,Amount";
    const line = (date: string, statement: string, amount: string) =>
      `${date},Synthetic Shop,Home,Overlap Visa,${statement},,${amount}`;
    const first = [
      line("2026-07-01", "SHOP ONE", "-11.00"),
      line("2026-07-02", "SHOP TWO", "-22.00"),
    ];
    const exportA = {
      fileName: "export-a.csv",
      text: [header, ...first].join("\n"),
    };
    const exportB = {
      fileName: "export-b.csv",
      text: [header, ...first, line("2026-07-03", "SHOP THREE", "-33.00")].join(
        "\n",
      ),
    };

    // Evidence only from A; nothing is settled yet.
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, { ...exportA, selected: [] }),
    ).toMatchObject({ transactions: 0, evidence: 2 });
    const previewA = await previewStatementCsv(ctx.db, ctx.actor, exportA);
    const previewB = await previewStatementCsv(ctx.db, ctx.actor, exportB);
    // Both files name the same stored occurrences for the shared charges.
    expect(
      previewB.preview?.rows.slice(0, 2).map((row) => row.proposed.sourceRef),
    ).toEqual(previewA.preview?.rows.map((row) => row.proposed.sourceRef));

    const all = ["1", "2", "3"].map((key) => ({
      key,
      kind: "purchase" as const,
    }));
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, {
        ...exportB,
        selected: all,
      }),
    ).toMatchObject({ transactions: 3, evidence: 1, alreadyPresent: 2 });
    expect(
      (await previewStatementCsv(ctx.db, ctx.actor, exportA)).preview?.rows.map(
        (row) => row.status,
      ),
    ).toEqual(["already_recorded", "already_recorded"]);
    // Settling A afterwards attaches nothing new and creates nothing.
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, {
        ...exportA,
        selected: all.slice(0, 2),
      }),
    ).toMatchObject({ transactions: 0, evidence: 0 });
    const counts = await getDb(ctx.db).execute(sql`
      SELECT
        (SELECT count(*)::int FROM "FinancialTransaction" WHERE "deletedAt" IS NULL) AS transactions,
        (SELECT count(*)::int FROM "StatementRow" WHERE "deletedAt" IS NULL) AS rows
    `);
    expect(counts.rows[0]).toEqual({ transactions: 3, rows: 3 });
    expect(
      (await listStatementRows(ctx.db, { matchState: "unmatched" })).count,
    ).toBe(0);
  });

  it("reviews no-ID pending-to-posted amount drift and preserves the canonical charge", async () => {
    const { output: account } = await createRepoEntity(
      ctx,
      "financialAccount",
      {
        name: "Synthetic tip card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        sourceAliases: [
          {
            source: "copilot",
            alias: "Synthetic Tip Visa",
            externalAccountId: null,
          },
        ],
      },
    );
    const header =
      "date,name,amount,status,category,type,account,account mask,note";
    const pending = {
      fileName: "pending-tip.csv",
      text: `${header}\n2026-08-16,Synthetic Tip Cafe,20,pending,Dining,regular,Synthetic Tip Visa,,`,
    };
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, { ...pending, selected: [] }),
    ).toMatchObject({ transactions: 0, evidence: 1 });
    const observation = (await listStatementRows(ctx.db, {})).data[0];
    if (!observation) throw new Error("Pending source observation missing");
    const original = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "pending",
        amount: 20,
        transactionDate: "2026-08-16",
        postedDate: null,
        merchant: "Synthetic Tip Cafe",
        rawDescription: "Synthetic Tip Cafe",
        sourceRefs: [{ source: "copilot", externalId: observation.externalId }],
      })
    ).output;
    const posted = {
      fileName: "posted-tip.csv",
      text: `${header}\n2026-08-18,Synthetic Tip Cafe,24,posted,Dining,regular,Synthetic Tip Visa,,`,
    };
    const preview = await previewStatementCsv(ctx.db, ctx.actor, posted);
    expect(preview.preview?.rows[0]).toMatchObject({
      status: "possible_existing",
      existingTransactionIds: [original.id],
      existingTransactions: [
        {
          id: original.id,
          amount: 20,
          status: "pending",
          transactionDate: "2026-08-16",
        },
      ],
    });
    await expect(
      commitStatementCsv(ctx.db, ctx.actor, {
        ...posted,
        selected: [{ key: "1", kind: "purchase" }],
      }),
    ).rejects.toThrow("needs review");
    const second = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 22,
        postedDate: "2026-08-17",
        merchant: "Synthetic Tip Cafe",
        rawDescription: "Synthetic Tip Cafe",
      })
    ).output;
    expect(
      (await previewStatementCsv(ctx.db, ctx.actor, posted)).preview?.rows[0]
        ?.existingTransactionIds,
    ).toEqual(expect.arrayContaining([original.id, second.id]));
    for (const text of [
      `${header}\n2026-08-18,Synthetic Tip Cafe,-24,posted,Dining,regular,Synthetic Tip Visa,,`,
      `${header}\n2026-08-18,Unrelated Synthetic Store,24,posted,Dining,regular,Synthetic Tip Visa,,`,
      `${header}\n2026-08-25,Synthetic Tip Cafe,24,posted,Dining,regular,Synthetic Tip Visa,,`,
    ])
      expect(
        (
          await previewStatementCsv(ctx.db, ctx.actor, {
            fileName: "separate.csv",
            text,
          })
        ).preview?.rows[0]?.status,
      ).toBe("ready_to_create");
    expect(
      await commitStatementCsv(ctx.db, ctx.actor, {
        ...posted,
        selected: [{ key: "1", transactionId: original.id }],
      }),
    ).toMatchObject({ transactions: 0, attached: 1, evidence: 1 });
    const saved = await getDb(ctx.db).execute(sql`
      SELECT amount, status, "transactionDate", "postedDate" FROM "FinancialTransaction" WHERE shortcode = ${original.id}
    `);
    expect(saved.rows[0]).toMatchObject({
      amount: 20,
      status: "pending",
      transactionDate: "2026-08-16",
      postedDate: null,
    });
    expect((await listStatementRows(ctx.db, {})).count).toBe(2);
    const refs = await getDb(ctx.db).execute(sql`
      SELECT count(*)::int AS count FROM "EntityExternalId" r JOIN "FinancialTransaction" t ON t.id = r."entityId"
      WHERE t.shortcode = ${original.id} AND r.kind = 'settlement_ref' AND r."deletedAt" IS NULL
    `);
    expect(refs.rows[0]?.count).toBe(2);
  });

  it("previews, confirms and safely replays a synthetic CSV through the native intake contract", async () => {
    await createRepoEntity(ctx, "financialAccount", {
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
    });
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
    expect(charge?.externalId).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("rejects a row without its physical file position", () => {
    expect(
      recordStatementRowsInput.safeParse({
        import: importInput(),
        rows: [rowInput()],
      }).success,
    ).toBe(false);
  });

  // Each Monarch export is the full history, so every file is a superset of
  // the last; occurrence-aware frozen-hash matching keeps that from minting a
  // second row per charge.
  it("skips rows another export already recorded, occurrence by occurrence", async () => {
    const r1 = rowInput({ statementDate: "2026-06-01", rawDescription: "R1" });
    const r2 = rowInput({ statementDate: "2026-06-02", rawDescription: "R2" });
    const r3 = rowInput({ statementDate: "2026-06-03", rawDescription: "R3" });
    expect(
      await record(ctx.db, ctx.actor, [r1, r2], { fingerprint: "fp-a" }),
    ).toMatchObject({ inserted: 2, alreadyInAnotherBatch: 0 });

    const superset = await record(ctx.db, ctx.actor, [r1, r2, r3], {
      fingerprint: "fp-b",
    });
    expect(superset).toMatchObject({
      inserted: 1,
      unchanged: 2,
      alreadyInThisBatch: 0,
      alreadyInAnotherBatch: 2,
    });
    const rows = (await listStatementRows(ctx.db, {})).data;
    expect(rows.map((row) => row.rawDescription).sort()).toEqual([
      "R1",
      "R2",
      "R3",
    ]);
  });

  it("records identical same-day charges once each, then skips both in a superset", async () => {
    const coffee = rowInput({
      statementDate: "2026-06-10",
      providerAmount: -4.5,
      rawDescription: "SYNTHETIC CAFE",
    });
    const lunch = rowInput({
      statementDate: "2026-06-11",
      providerAmount: -12,
      rawDescription: "SYNTHETIC DELI",
    });
    expect(
      await record(ctx.db, ctx.actor, [coffee, coffee], {
        fingerprint: "fp-twins",
      }),
    ).toMatchObject({ inserted: 2, alreadyInAnotherBatch: 0 });

    const superset = await record(ctx.db, ctx.actor, [coffee, coffee, lunch], {
      fingerprint: "fp-twins-superset",
    });
    expect(superset).toMatchObject({ inserted: 1, alreadyInAnotherBatch: 2 });

    const replay = await record(ctx.db, ctx.actor, [coffee, coffee, lunch], {
      fingerprint: "fp-twins-superset",
    });
    expect(replay).toMatchObject({
      inserted: 0,
      unchanged: 3,
      alreadyInThisBatch: 1,
      alreadyInAnotherBatch: 2,
    });
    expect((await listStatementRows(ctx.db, {})).count).toBe(3);
  });

  it("counts rows recorded before positions by their frozen v1 externalId", async () => {
    const r1 = rowInput({ statementDate: "2026-06-20", rawDescription: "OLD" });
    await record(ctx.db, ctx.actor, [r1], { fingerprint: "fp-pre-position" });
    // Shape of a row recorded before positions existed: the v1 hash is its
    // externalId and legacyExternalId was never written.
    await getDb(ctx.db).execute(sql`
      UPDATE "StatementRow"
      SET "externalId" = "legacyExternalId", "legacyExternalId" = NULL,
        "rowPosition" = NULL
    `);
    expect(
      await record(ctx.db, ctx.actor, [r1], {
        fingerprint: "fp-post-position",
      }),
    ).toMatchObject({ inserted: 0, alreadyInAnotherBatch: 1 });
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
      await createRepoEntity(ctx, "financialAccount", {
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
      })
    ).output;

    const transaction = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 128.5,
        postedDate: "2026-05-04",
        sourceRefs: [{ source: row!.source, externalId: row!.externalId }],
      })
    ).output;

    // No write to StatementRow: appending the ref on the transaction side is
    // what flips the row, which is why triage needs no new mutation surface.
    const afterMatch = (await listStatementRows(ctx.db, {})).data[0];
    expect(afterMatch).toMatchObject({
      matchState: "matched",
      transactionId: transaction.id,
    });

    // A soft-deleted transaction is not evidence.
    await deleteThroughKernel(ctx.db, ctx.actor, "financialTransaction", [
      transaction.id,
    ]);
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
      await createRepoEntity(ctx, "financialAccount", {
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
      })
    ).output;
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 128.5,
      postedDate: "2026-05-04",
      sourceRefs: rows.map((row) => ({
        source: row.source,
        externalId: row.externalId,
      })),
    });

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

  it("derives externalId server-side, matching the shared identity functions", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], { fingerprint: "fp-hash" });
    const [row] = (await listStatementRows(ctx.db, {})).data;
    await expect(
      statementRowOccurrenceId(row!.source, "fp-hash", 1),
    ).resolves.toBe(row!.externalId);
    // The stored columns reproduce the frozen v1 payload exactly; stored
    // settlement refs still carry it, so the ledger can audit that identity.
    await expect(
      statementRowExternalId({
        source: row!.source,
        account: row!.accountDescriptor,
        date: row!.statementDate,
        amount: row!.providerAmount,
        originalStatement: row!.rawDescription,
      }),
    ).resolves.toBe(row!.legacyExternalId);
  });
});
