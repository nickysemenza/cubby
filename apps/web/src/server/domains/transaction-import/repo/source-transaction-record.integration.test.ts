import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  sourceOccurrence,
  sourceTransactionRecord,
  transactionImportRecord,
  auditLog,
  financialEvidenceAlias,
} from "~/server/db/schema";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import {
  deleteThroughKernel,
  updateThroughKernel,
} from "~/server/testing/entity-kernel";

import {
  recordSourceTransactionRecords,
  updateSourceTransactionRecords,
  getSourceTransactionRecordSummary,
  findSourceTransactionRecordDrift,
  sourceTransactionRecordScaffold,
} from "./source-transaction-record";
import {
  listSourceTransactionRecords,
  listTransactionImports,
} from "./source-transaction-record.fixtures";

const rowInput = (
  overrides: Partial<SourceTransactionRecordInput> = {},
): SourceTransactionRecordInput => ({
  accountDescriptor: "Synthetic card",
  statementDate: "2026-05-04",
  providerAmount: -128.5,
  merchant: "Synthetic merchant",
  rawDescription: "SYNTHETIC PURCHASE",
  sourceCategory: "Home",
  providerStatus: "posted",
  providerNotes: null,
  ...overrides,
});
const importInput = (
  overrides: Partial<TransactionImportInput> = {},
): TransactionImportInput => ({
  source: "monarch",
  label: "Synthetic collection",
  fingerprint: "synthetic-original",
  dateKind: "transaction",
  rowCountDeclared: 2,
  notes: null,
  ...overrides,
});
const inputFor = (
  rows: SourceTransactionRecordInput[],
  overrides: Partial<TransactionImportInput> = {},
) =>
  recordSourceTransactionRecordsInput.parse({
    import: importInput({ rowCountDeclared: rows.length, ...overrides }),
    rows: rows.map((row, index) => ({ rowPosition: index + 1, ...row })),
  });
const providerRow = (overrides: Partial<SourceTransactionRecordInput> = {}) =>
  rowInput({
    providerTransactionId: "synthetic-event",
    providerAccountId: "synthetic-account",
    providerData: {
      transaction: { id: "synthetic-event", account_id: "synthetic-account" },
      account: { id: "synthetic-account" },
    },
    ...overrides,
  });

describe("statement row ledger", () => {
  const ctx = withTestDb();
  const record = (
    rows: SourceTransactionRecordInput[],
    overrides: Partial<TransactionImportInput> = {},
  ) =>
    recordSourceTransactionRecords(
      ctx.db,
      inputFor(rows, overrides),
      ctx.actor,
    );

  it("records distinct identical physical positions and replays the exact collection without effects", async () => {
    const input = inputFor([rowInput(), rowInput()]);
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        { ...input, dryRun: true },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ inserted: 2, batchId: null, dryRun: true });
    expect((await listTransactionImports(ctx.db)).count).toBe(0);
    await recordSourceTransactionRecords(ctx.db, input, ctx.actor);
    const before = (await listSourceTransactionRecords(ctx.db, {})).data;
    const owners = await getDb(ctx.db).select().from(sourceOccurrence);
    const audits = await getDb(ctx.db).select().from(auditLog);
    expect(before).toHaveLength(2);
    expect(new Set(before.map((row) => row.chargeKey)).size).toBe(2);
    expect(owners.map((owner) => owner.version)).toEqual([1, 1]);
    await expect(
      recordSourceTransactionRecords(ctx.db, input, ctx.actor),
    ).resolves.toMatchObject({
      inserted: 0,
      unchanged: 2,
      alreadyInThisBatch: 2,
      revised: 0,
    });
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual(
      before,
    );
    expect(await getDb(ctx.db).select().from(sourceOccurrence)).toEqual(owners);
    expect(await getDb(ctx.db).select().from(auditLog)).toEqual(audits);
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        {
          ...input,
          rows: [{ ...input.rows[0]!, providerAmount: -100 }, input.rows[1]!],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("retained collection");
  });

  it("keeps null scope and different attested provider accounts independent", async () => {
    await record([
      providerRow(),
      providerRow({
        rowPosition: 2,
        providerAccountId: "synthetic-other-account",
        providerData: {
          id: "synthetic-event",
          account_id: "synthetic-other-account",
        },
      }),
      rowInput({ rowPosition: 3, providerTransactionId: "synthetic-event" }),
    ]);
    const owners = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(owners).toHaveLength(3);
    expect(
      owners.filter((owner) => owner.identityKind === "provider"),
    ).toHaveLength(2);
    expect(
      owners.filter((owner) => owner.identityKind === "positioned"),
    ).toHaveLength(1);
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toHaveLength(
      3,
    );
  });

  it("reuses unchanged provider facts across collections while freezing each request and local annotation", async () => {
    const first = inputFor([
      providerRow({
        providerData: {
          id: "synthetic-event",
          account_id: "synthetic-account",
          annotation: "first",
        },
      }),
    ]);
    await recordSourceTransactionRecords(ctx.db, first, ctx.actor);
    const [owner] = await getDb(ctx.db).select().from(sourceOccurrence);
    const later = inputFor(
      [
        providerRow({
          rowPosition: 8,
          providerData: {
            id: "synthetic-event",
            account_id: "synthetic-account",
            annotation: "later",
          },
        }),
      ],
      { fingerprint: "synthetic-later", observedAt: "2026-06-02T00:00:00Z" },
    );
    await recordSourceTransactionRecords(ctx.db, later, ctx.actor);
    await expect(
      recordSourceTransactionRecords(ctx.db, later, ctx.actor),
    ).resolves.toMatchObject({
      inserted: 0,
      unchanged: 1,
      alreadyInThisBatch: 1,
    });
    const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerData).toEqual(first.rows[0]?.providerData);
    expect(
      (await getDb(ctx.db).select().from(sourceOccurrence))[0]?.version,
    ).toBe(owner?.version);
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(2);
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        {
          ...later,
          rows: [
            {
              ...later.rows[0]!,
              providerData: {
                id: "synthetic-event",
                account_id: "synthetic-account",
                annotation: "changed retained request",
              },
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("retained collection");
  });

  it("holds unordered provider revisions without copying judgments or moving accepted money", async () => {
    await record([providerRow()]);
    const [original] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!original) throw new Error("Synthetic observation missing");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      original.id,
      { notes: "Original local note" },
    );
    await record(
      [
        providerRow({
          providerAmount: -100,
          providerNotes: "Revised source fact",
        }),
      ],
      { fingerprint: "synthetic-revision" },
    );
    const [owner] = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(owner).toMatchObject({
      currentObservationId: null,
      reviewState: "revision_order_unknown",
      acceptedTransactionId: null,
      version: 2,
    });
    const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.id)?.notes).toBe(
      "Original local note",
    );
    expect(rows.find((row) => row.id !== original.id)?.notes).toBeNull();
    await record([providerRow()]);
    expect((await getDb(ctx.db).select().from(sourceOccurrence))[0]).toEqual(
      owner,
    );
    const successor = rows.find((row) => row.id !== original.id);
    if (!successor) throw new Error("Synthetic revision missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: original.source,
          externalIds: [original.externalId],
        },
        data: { supersededByExternalId: successor.externalId },
      },
      ctx.actor,
    );
    expect(
      (await getDb(ctx.db).select().from(sourceOccurrence))[0],
    ).toMatchObject({
      reviewState: "ready",
      currentObservationId: expect.any(String),
      acceptedTransactionId: null,
      version: 3,
    });
    expect(
      (await listSourceTransactionRecords(ctx.db, { current: true })).data[0]
        ?.id,
    ).toBe(successor.id);
  });

  it("accepts only an explicit occurrence handle and returns matching dollar values", async () => {
    await record([rowInput()]);
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!row) throw new Error("Synthetic observation missing");
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic account",
        identity: { kind: "cash" },
        cardNumbers: [],
        sourceAliases: [],
      })
    ).output;
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      row.id,
      { accountId: account.id },
    );
    await expect(
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "observed",
        amount: 128.5,
        sourceRefs: [{ source: row.source, externalId: row.externalId }],
      }),
    ).rejects.toThrow("legacy source reference");
    const transaction = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "observed",
        amount: 128.5,
        sourceRefs: [{ source: row.source, externalId: row.chargeKey }],
      })
    ).output;
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data[0],
    ).toMatchObject({
      matchState: "matched",
      transactionId: transaction.id,
      amount: 128.5,
      accountId: account.id,
    });
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
        row.id,
      ]),
    ).rejects.toThrow("accepted financial evidence");
    expect(await getSourceTransactionRecordSummary(ctx.db, {})).toMatchObject({
      matched: 1,
    });
    expect(
      (await getDb(ctx.db).select().from(sourceTransactionRecord))[0]?.amount,
    ).toBe(12850n);

    await record([rowInput()], { fingerprint: "synthetic-delete-race" });
    const racing = (await listSourceTransactionRecords(ctx.db, {})).data.find(
      (observation) => observation.id !== row.id,
    );
    if (!racing) throw new Error("Synthetic race observation missing");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      racing.id,
      {
        accountId: account.id,
      },
    );
    const outcomes = await Promise.allSettled([
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "observed",
        amount: 128.5,
        sourceRefs: [{ source: racing.source, externalId: racing.chargeKey }],
      }),
      deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
        racing.id,
      ]),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const { rows: violations } = await getDb(ctx.db).execute(sql`
      -- includes-deleted: a concurrent acceptance must never leave a deleted accepted head.
      SELECT count(*)::int AS count FROM "SourceOccurrence" owner
      JOIN "SourceTransactionRecord" head ON head.id=owner."currentObservationId"
      WHERE owner."acceptedTransactionId" IS NOT NULL AND head."deletedAt" IS NOT NULL`);
    expect(violations[0]).toMatchObject({ count: 0 });
  });

  it("retains explicit replacement decisions with cycle and deletion guards", async () => {
    await record([
      rowInput(),
      rowInput({
        providerAmount: -100,
        rawDescription: "Synthetic replacement",
      }),
    ]);
    const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
    const first = rows.find((row) => row.providerAmount === -128.5),
      second = rows.find((row) => row.providerAmount === -100);
    if (!first || !second) throw new Error("Synthetic pair missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: first.source, externalIds: [first.externalId] },
        data: { supersededByExternalId: second.externalId },
      },
      ctx.actor,
    );
    await expect(
      updateSourceTransactionRecords(
        ctx.db,
        {
          selector: { source: second.source, externalIds: [second.externalId] },
          data: { supersededByExternalId: first.externalId },
        },
        ctx.actor,
      ),
    ).rejects.toThrow("cycle");
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
        second.id,
      ]),
    ).rejects.toThrow("replacement");
    expect(
      (await listSourceTransactionRecords(ctx.db, { matchState: "superseded" }))
        .data[0]?.id,
    ).toBe(first.id);
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(2);
  });

  it("freezes completed coverage and holds reappearance after a confirmed withdrawal", async () => {
    const first = inputFor([providerRow()], {
      observedAt: "2026-05-05T00:00:00Z",
      coverage: {
        account: "synthetic-account",
        from: "2026-05-01",
        to: "2026-05-31",
        visibility: "all",
      },
    });
    await recordSourceTransactionRecords(
      ctx.db,
      { ...first, complete: true },
      ctx.actor,
    );
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        {
          ...first,
          rows: [
            providerRow({
              providerTransactionId: "synthetic-extra",
              providerData: {
                id: "synthetic-extra",
                account_id: "synthetic-account",
              },
            }),
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("completed collection");
    const removed = recordSourceTransactionRecordsInput.parse({
      import: importInput({
        fingerprint: "synthetic-absent",
        rowCountDeclared: 0,
        observedAt: "2026-06-01T00:00:00Z",
        coverage: first.import.coverage,
      }),
      rows: [],
      complete: true,
      confirmedWithdrawals: ["synthetic-event"],
    });
    await expect(
      recordSourceTransactionRecords(ctx.db, removed, ctx.actor),
    ).resolves.toMatchObject({ withdrawn: 1, completed: true });
    const before = (await getDb(ctx.db).select().from(sourceOccurrence))[0];
    await record([providerRow()], {
      fingerprint: "synthetic-reappeared",
      observedAt: "2026-06-02T00:00:00Z",
    });
    const after = (await getDb(ctx.db).select().from(sourceOccurrence))[0];
    expect(after).toMatchObject({
      reviewState: "reappeared",
      withdrawnAt: before?.withdrawnAt,
      acceptedTransactionId: null,
    });
    const retained = await getDb(ctx.db).select().from(sourceOccurrence);
    await record([providerRow()], {
      fingerprint: "synthetic-reappeared",
      observedAt: "2026-06-02T00:00:00Z",
    });
    expect(await getDb(ctx.db).select().from(sourceOccurrence)).toEqual(
      retained,
    );
  });

  it("keeps projection, drift and guarded judgment edits on the existing member surfaces", async () => {
    await record([rowInput(), rowInput()]);
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!row) throw new Error("Synthetic observation missing");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      row.id,
      { notes: "Reviewed local note" },
    );
    const projection = await sourceTransactionRecordScaffold.read(ctx.db, {
      filters: {},
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 10 },
      projection: selectedListProjection("sourceTransactionRecord", [
        "id",
        "source",
        "matchState",
      ]),
    });
    expect(projection.data[0]).not.toHaveProperty("providerData");
    expect(
      (
        await findSourceTransactionRecordDrift(ctx.db, {
          includeSameBatch: false,
          limit: 10,
        })
      ).candidates,
    ).toEqual([]);
    expect(
      (
        await findSourceTransactionRecordDrift(ctx.db, {
          includeSameBatch: true,
          limit: 10,
        })
      ).candidates,
    ).toHaveLength(1);
    await expect(
      updateSourceTransactionRecords(
        ctx.db,
        {
          selector: { filter: {} },
          data: { notes: "No unrestricted mutation" },
        },
        ctx.actor,
      ),
    ).rejects.toThrow("restricts nothing");
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: importInput({ fingerprint: "synthetic-unattested" }),
          rows: [rowInput()],
        }),
        ctx.actor,
      ),
    ).rejects.toThrow("physical collection position");
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.find(
        (candidate) => candidate.id === row.id,
      )?.notes,
    ).toBe("Reviewed local note");
    expect(
      await getDb(ctx.db).select().from(financialEvidenceAlias),
    ).toHaveLength(4);
    await expect(
      getDb(ctx.db).execute(sql`UPDATE "SourceTransactionRecord" SET amount=1`),
    ).rejects.toMatchObject({ cause: { code: "42703" } });
  });
});
