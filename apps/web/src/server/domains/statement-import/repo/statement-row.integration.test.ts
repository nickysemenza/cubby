import {
  recordStatementRowsInput,
  type StatementImportInput,
  type StatementRowInput,
} from "@cubby/schemas/statement-row";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { findIncompleteStatementImports } from "~/server/generic/problems/repo/detectors-financial";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";

import { statementImportMembers } from "./statement-import-membership";
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

  // Confirmed withdrawal is monotonic: an old collection cannot resurrect money.
  // Separate provider IDs also keep identical coexisting purchases independent.
  it("retains provider revisions and zero evidence without replaying a withdrawn head", async () => {
    const scope = {
      account: "synthetic-provider-account",
      from: "2026-05-01",
      to: "2026-05-31",
      visibility: "all",
    };
    const first = recordStatementRowsInput.parse({
      import: {
        ...importInput(),
        fingerprint: "synthetic-first-window",
        observedAt: "2026-06-01T00:00:00Z",
        coverage: scope,
        rowCountDeclared: 3,
      },
      rows: ["one", "two", "zero"].map((id) =>
        rowInput({
          providerAccountId: scope.account,
          providerTransactionId: id,
          providerAmount: id === "zero" ? 0 : -25,
          providerStatus: null,
        }),
      ),
      complete: true,
    });
    await recordStatementRows(ctx.db, first, ctx.actor);
    const initial = await listStatementRows(ctx.db, {});
    expect(new Set(initial.data.map((row) => row.chargeKey)).size).toBe(3);
    const second = recordStatementRowsInput.parse({
      import: {
        ...importInput(),
        fingerprint: "synthetic-second-window",
        observedAt: "2026-06-02T00:00:00Z",
        coverage: scope,
        rowCountDeclared: 1,
      },
      rows: [
        rowInput({
          providerAccountId: scope.account,
          providerTransactionId: "two",
          providerAmount: -30,
          providerStatus: "posted",
        }),
      ],
      complete: true,
      confirmedWithdrawals: ["one"],
    });
    expect(await recordStatementRows(ctx.db, second, ctx.actor)).toMatchObject({
      inserted: 1,
      revised: 1,
      withdrawn: 1,
      completed: true,
    });
    await recordStatementRows(ctx.db, first, ctx.actor);
    const all = (await listStatementRows(ctx.db, {})).data;
    expect(all).toHaveLength(4);
    expect(
      all.find((row) => row.providerTransactionId === "one")?.withdrawnAt,
    ).toEqual(new Date("2026-06-02T00:00:00Z"));
    expect(
      all.filter((row) => row.current && row.providerTransactionId === "two"),
    ).toMatchObject([{ amount: 30, providerStatus: "posted" }]);
    expect(
      all.find((row) => row.providerTransactionId === "zero")?.amount,
    ).toBe(0);
    await expect(
      recordStatementRows(
        ctx.db,
        recordStatementRowsInput.parse({
          ...second,
          import: {
            ...second.import,
            fingerprint: "synthetic-visible-window",
            coverage: { ...scope, visibility: "visible" },
          },
          rows: second.rows,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(
      "Withdrawals require a completed, rechecked account window.",
    );
  });

  // Account identity enrichment must survive as evidence; completed coverage
  // cannot later acquire members that undermine its absence proof.
  it("retains an enriched provider account and freezes completed membership", async () => {
    const original = rowInput({
      providerTransactionId: "synthetic-enriched-record",
    });
    await record(ctx.db, ctx.actor, [original], {
      fingerprint: "synthetic-before-account-id",
      observedAt: "2026-06-01T00:00:00Z",
      rowCountDeclared: 1,
    });
    const scope: NonNullable<StatementImportInput["coverage"]> = {
      account: "synthetic-enriched-account",
      from: "2026-05-01",
      to: "2026-05-31",
      visibility: "all",
    };
    const enriched = recordStatementRowsInput.parse({
      import: importInput({
        fingerprint: "synthetic-enriched-window",
        observedAt: "2026-06-02T00:00:00Z",
        coverage: scope,
        rowCountDeclared: 1,
      }),
      rows: [{ ...original, providerAccountId: scope.account }],
      complete: true,
    });
    expect(
      await recordStatementRows(ctx.db, enriched, ctx.actor),
    ).toMatchObject({
      inserted: 1,
      revised: 1,
      completed: true,
    });
    const observations = (await listStatementRows(ctx.db, {})).data;
    expect(new Set(observations.map((row) => row.chargeKey)).size).toBe(1);
    expect(observations.find((row) => row.current)?.providerAccountId).toBe(
      scope.account,
    );
    expect(
      await record(
        ctx.db,
        ctx.actor,
        [{ ...original, providerAccountId: "synthetic-other-account" }],
        {
          fingerprint: "synthetic-other-account-window",
          observedAt: "2026-06-03T00:00:00Z",
          rowCountDeclared: 1,
        },
      ),
    ).toMatchObject({ inserted: 1, revised: 0 });
    const separate = (await listStatementRows(ctx.db, {})).data;
    expect(new Set(separate.map((row) => row.chargeKey)).size).toBe(2);
    expect(
      separate.filter((row) => row.current).map((row) => row.providerAccountId),
    ).toEqual(
      expect.arrayContaining([scope.account, "synthetic-other-account"]),
    );
    await expect(
      recordStatementRows(
        ctx.db,
        recordStatementRowsInput.parse({
          ...enriched,
          complete: false,
          rows: [
            {
              ...enriched.rows[0],
              providerTransactionId: "synthetic-added-too-late",
            },
          ],
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(
      "A completed collection cannot admit additional observations",
    );
    expect(
      await recordStatementRows(
        ctx.db,
        recordStatementRowsInput.parse({
          import: {
            ...enriched.import,
            fingerprint: "synthetic-enriched-absence",
            observedAt: "2026-06-03T00:00:00Z",
            rowCountDeclared: 0,
          },
          rows: [],
          complete: true,
          confirmedWithdrawals: ["synthetic-enriched-record"],
        }),
        ctx.actor,
      ),
    ).toMatchObject({ withdrawn: 1 });
  });

  it("replays historical unpositioned membership without moving ignored or booked ownership", async () => {
    const rows = [
      rowInput(),
      rowInput({ rawDescription: "SYNTHETIC BOOKED CHARGE" }),
    ];
    const fingerprint = "synthetic-historical-membership";
    await record(ctx.db, ctx.actor, rows, { fingerprint });
    // The migration retains v1 observations and charge owners rather than
    // rehashing historical references into the current collection identity.
    await getDb(ctx.db).execute(sql`
      UPDATE "StatementRow" SET "externalId" = "legacyExternalId",
        "chargeKey" = "legacyExternalId", "legacyReference" = "legacyExternalId"
    `);
    const historical = (await listStatementRows(ctx.db, {})).data;
    const ignored = historical.find(
      (row) => row.rawDescription === rows[0]!.rawDescription,
    )!;
    const booked = historical.find(
      (row) => row.rawDescription === rows[1]!.rawDescription,
    )!;
    await updateStatementRows(
      ctx.db,
      {
        selector: { source: "monarch", externalIds: [ignored.externalId] },
        data: {
          disposition: "ignored",
          dispositionReason: "not_modeled",
          dispositionNote: "Synthetic reviewed exclusion",
        },
      },
      ctx.actor,
    );
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic account",
      })
    ).output;
    const transaction = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: booked.amount,
        postedDate: booked.statementDate,
        sourceRefs: [{ source: booked.source, externalId: booked.externalId }],
      })
    ).output;
    const before = (await listStatementRows(ctx.db, {})).data;
    expect(
      await record(ctx.db, ctx.actor, rows, { fingerprint }),
    ).toMatchObject({
      inserted: 0,
      unchanged: 2,
      revised: 0,
      alreadyInThisBatch: 2,
      rowCountStored: 2,
    });
    expect((await listStatementRows(ctx.db, {})).data).toEqual(before);
    expect(before.find((row) => row.id === ignored.id)?.matchState).toBe(
      "ignored",
    );
    expect(before.find((row) => row.id === booked.id)?.transactionId).toBe(
      transaction.id,
    );
    await expect(
      record(
        ctx.db,
        ctx.actor,
        rows.map((row, index) => ({ ...row, rowPosition: index + 1 })),
        { fingerprint },
      ),
    ).rejects.toThrow("physical positions");
    expect((await listStatementRows(ctx.db, {})).data).toEqual(before);
    expect(
      await record(ctx.db, ctx.actor, rows, {
        fingerprint: "synthetic-independent-collection",
      }),
    ).toMatchObject({ inserted: 2, revised: 0 });
    expect(
      new Set(
        (await listStatementRows(ctx.db, {})).data.map((row) => row.chargeKey),
      ).size,
    ).toBe(4);
  });

  it("refuses unpositioned replay of indistinguishable physical collection members", async () => {
    const fingerprint = "synthetic-ambiguous-membership";
    await record(
      ctx.db,
      ctx.actor,
      [rowInput({ rowPosition: 1 }), rowInput({ rowPosition: 2 })],
      { fingerprint },
    );
    const before = (await listStatementRows(ctx.db, {})).data;
    await expect(
      record(ctx.db, ctx.actor, [rowInput()], { fingerprint }),
    ).rejects.toThrow("physical positions");
    expect((await listStatementRows(ctx.db, {})).data).toEqual(before);
  });

  it("refuses conflicting historical position identities instead of matching content", async () => {
    const fingerprint = "synthetic-mispositioned-membership";
    const rows = [
      rowInput({ rowPosition: 1 }),
      rowInput({ rowPosition: 2, rawDescription: "SYNTHETIC SECOND CHARGE" }),
    ];
    await record(ctx.db, ctx.actor, rows, { fingerprint });
    const retained = (await listStatementRows(ctx.db, {})).data;
    const first = retained.find((row) => row.rowPosition === 1)!;
    const second = retained.find((row) => row.rowPosition === 2)!;
    await getDb(ctx.db).execute(
      sql`UPDATE "StatementRow" SET "externalId" = "legacyExternalId"`,
    );
    await getDb(ctx.db).execute(sql`
      UPDATE "StatementRow" SET
        "externalId" = CASE WHEN "rowPosition" = 1 THEN ${second.externalId} ELSE ${first.externalId} END,
        "chargeKey" = CASE WHEN "rowPosition" = 1 THEN ${second.externalId} ELSE ${first.externalId} END
    `);
    const before = (await listStatementRows(ctx.db, {})).data;
    await expect(
      record(ctx.db, ctx.actor, rows, { fingerprint }),
    ).rejects.toThrow(
      "An observation identity cannot change its original evidence",
    );
    expect((await listStatementRows(ctx.db, {})).data).toEqual(before);
  });

  // Opaque handles must survive replay, distinguish observations and keep
  // the paged roster/count aligned with the full-filtered-set footer.
  it("keeps opaque read IDs across reimport and filtered pages", async () => {
    const rows = [1, 2, 3].map((rowPosition) => rowInput({ rowPosition }));
    const fingerprint = "read-handle-pages";
    await record(ctx.db, ctx.actor, rows, { fingerprint, rowCountDeclared: 3 });
    await record(ctx.db, ctx.actor, [rowInput({ rowPosition: 1 })], {
      fingerprint: "another-read-handle-export",
      rowCountDeclared: 1,
    });
    const filters = { source: "monarch", importFingerprint: fingerprint };
    const sort = { orderBy: "statementDate", direction: "asc" as const };
    const first = await listStatementRows(
      ctx.db,
      filters,
      { pageIndex: 0, pageSize: 2 },
      sort,
    );
    const second = await listStatementRows(
      ctx.db,
      filters,
      { pageIndex: 1, pageSize: 2 },
      sort,
    );
    expect(first.count).toBe(3);
    expect(second.count).toBe(3);
    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    const original = [...first.data, ...second.data];
    expect(new Set(original.map((row) => row.id)).size).toBe(3);
    for (const row of original)
      expect(row.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(new Set(original.map((row) => row.externalId)).size).toBe(3);
    expect(
      (await getStatementRowSummary(ctx.db, filters)).amountTotal,
    ).toBeCloseTo(3 * 128.5);
    expect(first.data.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(
      2 * 128.5,
    );
    await record(ctx.db, ctx.actor, rows, { fingerprint, rowCountDeclared: 3 });
    const repeated = await listStatementRows(
      ctx.db,
      filters,
      { pageIndex: 0, pageSize: 4 },
      sort,
    );
    expect(repeated.data).toEqual(original);
  });

  // Failure modes: reviewed normalization creates another row, moves first
  // ownership, rewrites provider evidence, or accepts a different account mask.
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
    expect(charge?.legacyExternalId).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  // Failure modes: overlap looks incomplete, replay inflates coverage, a
  // preview persists membership, or an export steals another export's rows.
  it("tracks overlapping export coverage without moving retained statement rows", async () => {
    const shared = rowInput({
      providerTransactionId: "synthetic-overlapping-record",
    });
    const later = rowInput({
      statementDate: "2026-05-08",
      rawDescription: "SECOND ORDER",
    });
    const first = await record(ctx.db, ctx.actor, [shared], {
      observedAt: "2026-06-01T00:00:00Z",
      rowCountDeclared: 1,
    });
    const original = (await listStatementRows(ctx.db, {})).data[0];
    const overlapping = {
      fingerprint: "fp-overlapping",
      observedAt: "2026-06-02T00:00:00Z",
      label: "overlapping.csv",
      rowCountDeclared: 2,
    };
    expect(
      await record(ctx.db, ctx.actor, [shared], overlapping, true),
    ).toMatchObject({
      batchCreated: false,
      inserted: 0,
      unchanged: 1,
      alreadyInAnotherBatch: 1,
      refreshed: 1,
    });
    expect((await listStatementImports(ctx.db)).count).toBe(1);
    const partial = await record(ctx.db, ctx.actor, [shared], overlapping);
    expect(partial).toMatchObject({
      inserted: 0,
      unchanged: 1,
      rowCountStored: 1,
      refreshed: 1,
    });
    expect(await findIncompleteStatementImports(ctx.db)).toMatchObject([
      {
        fingerprint: overlapping.fingerprint,
        rowCountDeclared: 2,
        rowCountStored: 1,
      },
    ]);
    expect(await record(ctx.db, ctx.actor, [later], overlapping)).toMatchObject(
      {
        inserted: 1,
        rowCountStored: 2,
      },
    );
    const beforeReplay = (await listStatementRows(ctx.db, {})).data;
    expect(
      await record(ctx.db, ctx.actor, [shared, later], overlapping),
    ).toMatchObject({
      inserted: 0,
      unchanged: 2,
      refreshed: 0,
      rowCountStored: 2,
    });
    expect(await findIncompleteStatementImports(ctx.db)).toEqual([]);
    // First-batch ownership and recorded membership name the same pair once.
    const members = await getDb(ctx.db).execute(
      sql`SELECT count(*)::int AS rows, count(DISTINCT (member."importId", member."statementRowId"))::int AS pairs FROM ${statementImportMembers} member`,
    );
    expect(members.rows).toEqual([{ rows: 3, pairs: 3 }]);
    expect((await listStatementImports(ctx.db)).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: importInput().fingerprint,
          rowCountStored: first.rowCountStored,
        }),
        expect.objectContaining({
          fingerprint: overlapping.fingerprint,
          rowCountStored: 2,
        }),
      ]),
    );
    const all = await listStatementRows(ctx.db, {});
    expect(all.count).toBe(2);
    expect(all.data).toEqual(beforeReplay);
    expect(
      all.data.find((row) => row.externalId === original?.externalId),
    ).toEqual({ ...original, updatedAt: expect.any(Date) });
    expect(
      (
        await listStatementRows(ctx.db, {
          importFingerprint: overlapping.fingerprint,
        })
      ).count,
    ).toBe(2);
    const financial = await getDb(ctx.db).execute(
      sql`SELECT count(*)::int AS count FROM "FinancialTransaction"`,
    );
    expect(financial.rows).toEqual([{ count: 0 }]);
  });

  it("excludes proven same-export pairs while retaining genuine cross-export drift", async () => {
    const shared = rowInput({
      providerTransactionId: "synthetic-shared-export-record",
    });
    const differentDescription = rowInput({
      rawDescription: "DISTINCT PURCHASE",
    });
    await record(ctx.db, ctx.actor, [shared], { rowCountDeclared: 1 });
    await record(ctx.db, ctx.actor, [shared, differentDescription], {
      fingerprint: "fp-shared-export",
    });
    const input = { source: "monarch", includeSameBatch: false, limit: 100 };
    expect(
      (
        await findStatementRowDrift(ctx.db, {
          ...input,
          importFingerprint: "fp-shared-export",
        })
      ).candidates,
    ).toEqual([]);
    expect((await findStatementRowDrift(ctx.db, input)).candidates).toEqual([]);
    await record(
      ctx.db,
      ctx.actor,
      [rowInput({ rawDescription: "POSSIBLE REEXPORT" })],
      { fingerprint: "fp-separate-export", rowCountDeclared: 1 },
    );
    expect(
      (await findStatementRowDrift(ctx.db, input)).candidates,
    ).toMatchObject([{ crossBatch: true, rows: expect.any(Array) }]);
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

  // The list footer reads a state's total from the unfiltered summary instead
  // of a second summary filtered to that state; the two must agree.
  it("splits the summary amount by match state as a state filter totals it", async () => {
    await record(
      ctx.db,
      ctx.actor,
      [
        rowInput(),
        rowInput({
          merchant: "Example Market",
          rawDescription: "EXAMPLE MARKET OAKLAND CA",
          providerAmount: -20.25,
        }),
      ],
      { fingerprint: "fp-summary-split" },
    );
    const matchedRow = (await listStatementRows(ctx.db, {})).data.find(
      (row) => row.merchant === "Acme Supply",
    );
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Test Card",
        identity: { kind: "credit_card", issuer: null, network: "amex" },
        cardNumbers: [],
        sourceAliases: [],
      })
    ).output;
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 128.5,
      postedDate: "2026-05-04",
      sourceRefs: [
        { source: matchedRow!.source, externalId: matchedRow!.externalId },
      ],
    });

    const summary = await getStatementRowSummary(ctx.db, {});
    expect(summary).toMatchObject({ matched: 1, unmatched: 1 });
    expect(summary.matchedAmount).not.toBe(0);
    expect(summary.unmatchedAmount).not.toBe(0);
    for (const matchState of [
      "matched",
      "unmatched",
      "ignored",
      "superseded",
    ] as const) {
      expect(summary[`${matchState}Amount`]).toBe(
        (await getStatementRowSummary(ctx.db, { matchState })).amountTotal,
      );
    }
    expect(
      summary.matchedAmount +
        summary.unmatchedAmount +
        summary.ignoredAmount +
        summary.supersededAmount,
    ).toBeCloseTo(summary.amountTotal);
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

  it("retains the frozen legacy content hash beside the observation identity", async () => {
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
    ).resolves.toBe(row!.legacyExternalId);
  });
});
