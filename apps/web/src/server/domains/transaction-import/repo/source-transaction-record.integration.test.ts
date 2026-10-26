import {
  recordSourceTransactionRecordsInput,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  auditLog,
  sourceTransactionRecord,
  transactionImportRecord,
} from "~/server/db/schema";
import { getAuditLog } from "~/server/generic/audit-log/repo/audit-log";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { findIncompleteTransactionImports } from "~/server/generic/problems/repo/detectors-financial";
import {
  deleteThroughKernel,
  updateThroughKernel,
} from "~/server/testing/entity-kernel";

import {
  findSourceTransactionRecordDrift,
  getSourceTransactionRecordSummary,
  listSourceTransactionRecordsRead,
  recordSourceTransactionRecords,
  updateSourceTransactionRecords,
} from "./source-transaction-record";
import {
  sourceTransactionRecordExternalId,
  sourceTransactionRecordOccurrenceId,
} from "./source-transaction-record-identity";
import {
  listTransactionImports,
  listSourceTransactionRecords,
} from "./source-transaction-record.fixtures";
import { transactionImportMembers } from "./transaction-import-membership";

const importInput = (
  overrides: Partial<TransactionImportInput> = {},
): TransactionImportInput => ({
  source: "monarch",
  label: "monarch-2026-08.csv",
  fingerprint: "fp-monarch-1",
  dateKind: "transaction" as const,
  rowCountDeclared: 2,
  notes: null,
  ...overrides,
});

const rowInput = (
  overrides: Partial<SourceTransactionRecordInput> = {},
): SourceTransactionRecordInput => ({
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
  db: Parameters<typeof recordSourceTransactionRecords>[0],
  actor: Parameters<typeof recordSourceTransactionRecords>[2],
  rows: SourceTransactionRecordInput[],
  importOverrides: Partial<TransactionImportInput> = {},
  dryRun = false,
) =>
  recordSourceTransactionRecords(
    db,
    recordSourceTransactionRecordsInput.parse({
      import: importInput(importOverrides),
      rows: rows.map((row, index) => ({ rowPosition: index + 1, ...row })),
      dryRun,
    }),
    actor,
  );

describe("statement row ledger", () => {
  const ctx = withTestDb();

  it.each(["positioned", "historical"])(
    "refuses introducing a provider identity over retained %s collection evidence",
    async (positionRetention) => {
      const original = rowInput();
      await record(ctx.db, ctx.actor, [original]);
      if (positionRetention === "historical") {
        // Older imports did not retain file positions; content cannot assign a new provider identity.
        await getDb(ctx.db)
          .update(sourceTransactionRecord)
          .set({ rowPosition: null });
      }
      const before = await getDb(ctx.db).select().from(sourceTransactionRecord);
      for (const dryRun of [true, false]) {
        await expect(
          record(
            ctx.db,
            ctx.actor,
            [
              {
                ...original,
                providerTransactionId: "synthetic-new-provider-id",
              },
            ],
            {},
            dryRun,
          ),
        ).rejects.toThrow("retained collection");
      }
      expect(
        await getDb(ctx.db).select().from(sourceTransactionRecord),
      ).toEqual(before);
      expect(
        await getDb(ctx.db).select().from(transactionImportRecord),
      ).toHaveLength(1);
    },
  );

  it("replays an existing provider member beside historical ID-less evidence", async () => {
    const original = rowInput();
    const provider = rowInput({
      rowPosition: 2,
      providerTransactionId: "synthetic-retained-provider",
    });
    await record(ctx.db, ctx.actor, [original, provider]);
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ rowPosition: null })
      .where(sql`${sourceTransactionRecord.providerTransactionId} IS NULL`);
    const before = (await getDb(ctx.db).select().from(sourceTransactionRecord))
      .map((row) => row.externalId)
      .sort();
    for (const dryRun of [true, false]) {
      await expect(
        record(ctx.db, ctx.actor, [provider], {}, dryRun),
      ).resolves.toMatchObject({ unchanged: 1, inserted: 0 });
    }
    expect(
      (await getDb(ctx.db).select().from(sourceTransactionRecord))
        .map((row) => row.externalId)
        .sort(),
    ).toEqual(before);
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(2);
  });

  it.each(["retained", "missing"])(
    "replays a frozen provider occurrence with %s legacy identity without moving accepted ownership",
    async (legacyIdentity) => {
      const fingerprint = "synthetic-frozen-provider-collection";
      const input = rowInput({
        rowPosition: 7,
        providerTransactionId: "synthetic-frozen-provider",
        providerData: { original: "synthetic retained evidence" },
      });
      const importScope = {
        fingerprint,
        rowCountDeclared: 1,
        observedAt: "2026-06-01T00:00:00Z",
      };
      await record(ctx.db, ctx.actor, [input], importScope);
      const [stored] = await getDb(ctx.db)
        .select()
        .from(sourceTransactionRecord);
      if (!stored) throw new Error("Synthetic provider observation missing");
      const frozen = await sourceTransactionRecordOccurrenceId(
        "monarch",
        fingerprint,
        7,
      );
      // Older provider-bearing imports retained physical occurrence identities.
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({
          externalId: frozen,
          chargeKey: frozen,
          legacyExternalId:
            legacyIdentity === "missing" ? null : stored.legacyExternalId,
        })
        .where(eq(sourceTransactionRecord.id, stored.id));
      const account = (
        await createRepoEntity(ctx, "financialAccount", {
          name: "Synthetic replay account",
        })
      ).output;
      const transaction = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.id,
        kind: "purchase",
        status: "posted",
        amount: 128.5,
        postedDate: input.statementDate,
        sourceRefs: [{ source: "monarch", externalId: frozen }],
      });
      const before = await getDb(ctx.db).select().from(sourceTransactionRecord);
      expect(before[0]).toMatchObject({
        providerTransactionId: input.providerTransactionId,
        providerAccountId: null,
        chargeKey: frozen,
      });
      for (const dryRun of [true, false])
        await expect(
          record(ctx.db, ctx.actor, [input], importScope, dryRun),
        ).resolves.toMatchObject({
          inserted: 0,
          unchanged: 1,
          revised: 0,
          refreshed: 0,
          alreadyInThisBatch: 1,
        });
      expect(
        await getDb(ctx.db).select().from(sourceTransactionRecord),
      ).toEqual(before);
      for (const changed of [
        { ...input, providerAmount: -129 },
        { ...input, providerData: { original: "synthetic altered evidence" } },
      ])
        await expect(
          record(ctx.db, ctx.actor, [changed], importScope),
        ).rejects.toThrow("original evidence");
      const later = await record(
        ctx.db,
        ctx.actor,
        [{ ...input, providerNotes: "Synthetic later revision" }],
        {
          ...importScope,
          fingerprint: "synthetic-later-provider-collection",
          observedAt: "2026-06-02T00:00:00Z",
        },
      );
      expect(later).toMatchObject({ inserted: 1, revised: 1 });
      await record(ctx.db, ctx.actor, [input], importScope);
      const history = await getDb(ctx.db)
        .select()
        .from(sourceTransactionRecord);
      expect(history).toHaveLength(2);
      expect(history.every((row) => row.chargeKey === frozen)).toBe(true);
      expect(history.find((row) => row.externalId === frozen)?.current).toBe(
        false,
      );
      expect(
        (await listSourceTransactionRecords(ctx.db, {})).data.every(
          (row) => row.transactionId === transaction.output.id,
        ),
      ).toBe(true);
      expect(
        await getDb(ctx.db).select().from(transactionImportRecord),
      ).toHaveLength(2);
    },
  );

  it("refuses replaying a deleted frozen provider member", async () => {
    const input = rowInput({
      providerTransactionId: "synthetic-deleted-provider",
    });
    await record(ctx.db, ctx.actor, [input]);
    const [stored] = await getDb(ctx.db).select().from(sourceTransactionRecord);
    if (!stored) throw new Error("Synthetic provider observation missing");
    const frozen = await sourceTransactionRecordOccurrenceId(
      "monarch",
      "fp-monarch-1",
      1,
    );
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ externalId: frozen, chargeKey: frozen })
      .where(eq(sourceTransactionRecord.id, stored.id));
    await deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
      stored.shortcode,
    ]);
    const before = await getDb(ctx.db).select().from(sourceTransactionRecord);
    await expect(record(ctx.db, ctx.actor, [input], {}, true)).rejects.toThrow(
      "one live observation",
    );
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual(
      before,
    );
  });

  it.each(["together", "later chunk"])(
    "keeps null-ID account scopes distinct when admitted %s and replayed",
    async (admission) => {
      const fingerprint = "synthetic-descriptor-scoped-accounts";
      const rows = ["Synthetic account A", "Synthetic account B"].map(
        (accountDescriptor, index) =>
          rowInput({
            accountDescriptor,
            rowPosition: index + 1,
            providerTransactionId: "synthetic-account-scoped-transaction",
            providerAccountId: null,
          }),
      );
      const scope = { fingerprint, rowCountDeclared: 2 };
      if (admission === "together")
        await record(ctx.db, ctx.actor, rows, scope);
      else
        for (const row of rows) await record(ctx.db, ctx.actor, [row], scope);
      const admitted = await getDb(ctx.db)
        .select()
        .from(sourceTransactionRecord);
      expect(new Set(admitted.map((row) => row.chargeKey)).size).toBe(2);
      for (const row of admitted) {
        if (row.rowPosition === null)
          throw new Error("Synthetic physical position missing");
        const frozen = await sourceTransactionRecordOccurrenceId(
          "monarch",
          fingerprint,
          row.rowPosition,
        );
        await getDb(ctx.db)
          .update(sourceTransactionRecord)
          .set({ externalId: frozen, chargeKey: frozen })
          .where(eq(sourceTransactionRecord.id, row.id));
      }
      const before = await getDb(ctx.db).select().from(sourceTransactionRecord);
      for (const dryRun of [true, false])
        await expect(
          record(ctx.db, ctx.actor, rows, scope, dryRun),
        ).resolves.toMatchObject({
          inserted: 0,
          unchanged: 2,
          revised: 0,
          alreadyInThisBatch: 2,
        });
      expect(
        await getDb(ctx.db).select().from(sourceTransactionRecord),
      ).toEqual(before);
      expect(
        await getDb(ctx.db).select().from(transactionImportRecord),
      ).toHaveLength(2);
    },
  );

  it("retains a distinct positioned occurrence when a later chunk supplies its provider ID", async () => {
    const original = rowInput();
    await record(ctx.db, ctx.actor, [original]);
    await record(ctx.db, ctx.actor, [
      {
        ...original,
        rowPosition: 2,
        providerTransactionId: "synthetic-independent-id",
      },
    ]);
    const rows = await getDb(ctx.db).select().from(sourceTransactionRecord);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.chargeKey)).size).toBe(2);
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(2);
  });

  it("refuses new unpositioned observations before creating evidence collections", async () => {
    for (const dryRun of [true, false]) {
      await expect(
        record(
          ctx.db,
          ctx.actor,
          [rowInput({ rowPosition: undefined })],
          {},
          dryRun,
        ),
      ).rejects.toThrow("stable physical row position");
    }
    expect((await listTransactionImports(ctx.db)).data).toEqual([]);
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual([]);
    expect(await getDb(ctx.db).select().from(auditLog)).toEqual([]);
  });

  it("audits intake and judgment changes once while keeping provider evidence immutable", async () => {
    const input = recordSourceTransactionRecordsInput.parse({
      import: importInput({
        fingerprint: "synthetic-audited-intake",
        rowCountDeclared: 1,
      }),
      rows: [rowInput({ rowPosition: 1, providerData: { synthetic: true } })],
    });
    const audits = () =>
      getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          inArray(auditLog.entityKind, [
            "sourceTransactionRecord",
            "transactionImport",
          ]),
        );
    await recordSourceTransactionRecords(
      ctx.db,
      { ...input, dryRun: true },
      ctx.actor,
    );
    expect(await audits()).toEqual([]);
    expect(await getDb(ctx.db).select().from(transactionImportRecord)).toEqual(
      [],
    );

    await recordSourceTransactionRecords(ctx.db, input, ctx.actor);
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(row).toBeDefined();
    expect(row!.id).toMatch(/^STR-/);
    expect(row!.batchId).toMatch(/^TIM-/);
    expect(row!.displayName).toBe(input.rows[0]!.rawDescription);
    const initialAudits = await audits();
    expect(initialAudits).toHaveLength(2);
    expect(
      initialAudits.find((entry) => entry.entityKind === "transactionImport")
        ?.changes,
    ).toMatchObject({ records: { to: [expect.any(String)] } });
    for (const entry of initialAudits)
      expect(entry.changes).not.toHaveProperty("id");
    const [stored] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord)
      .where(eq(sourceTransactionRecord.shortcode, row!.id));

    const publicAudit = await getAuditLog(ctx.db, {
      entityKind: "transactionImport",
      limit: 25,
    });
    expect(publicAudit.entries[0]?.changes).toMatchObject({
      records: { to: [row!.id] },
    });
    expect(publicAudit.entries[0]?.references).toHaveProperty(row!.id);
    expect(
      initialAudits.find((entry) => entry.entityKind === "transactionImport")
        ?.changes,
    ).toMatchObject({ records: { to: [stored!.id] } });

    await recordSourceTransactionRecords(ctx.db, input, ctx.actor);
    expect(await audits()).toEqual(initialAudits);
    expect((await listSourceTransactionRecords(ctx.db, {})).data[0]).toEqual(
      row,
    );
    const [replayed] = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord)
      .where(eq(sourceTransactionRecord.shortcode, row!.id));
    expect(replayed?.id).toBe(stored?.id);

    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        {
          ...input,
          rows: [{ ...input.rows[0]!, providerData: { synthetic: "changed" } }],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("original evidence");
    expect(await audits()).toEqual(initialAudits);

    const base = await listSourceTransactionRecordsRead(
      ctx.db,
      {},
      [],
      { pageIndex: 0, pageSize: 10 },
      selectedListProjection("sourceTransactionRecord", [
        "id",
        "source",
        "matchState",
      ]),
    );
    expect(base.data[0]).toMatchObject({
      id: row!.id,
      source: input.import.source,
      matchState: "unmatched",
    });
    expect(base.data[0]).not.toHaveProperty("providerData");
    expect(base.data[0]).not.toHaveProperty("vendorInference");
    expect(base.data[0]).not.toHaveProperty("accountName");
    const metadata = await listSourceTransactionRecordsRead(
      ctx.db,
      {},
      [],
      { pageIndex: 0, pageSize: 10 },
      selectedListProjection("sourceTransactionRecord", ["id", "providerData"]),
    );
    expect(metadata.data).toEqual([
      { id: row!.id, providerData: { synthetic: true } },
    ]);

    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      row!.id,
      { notes: "Synthetic reviewed note" },
    );
    expect(await audits()).toHaveLength(3);
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      row!.id,
      { notes: "Synthetic reviewed note" },
    );
    expect(await audits()).toHaveLength(3);
    const [reviewed] = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(reviewed?.notes).toBe("Synthetic reviewed note");
    expect(reviewed?.providerData).toEqual(row!.providerData);
  });

  it("blocks deleting a superseding record and retains import membership after an unreferenced deletion", async () => {
    await record(ctx.db, ctx.actor, [
      rowInput({ rowPosition: 1 }),
      rowInput({ rowPosition: 2, rawDescription: "SYNTHETIC SECOND PURCHASE" }),
    ]);
    const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
    const predecessor = rows[0]!;
    const successor = rows[1]!;
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        predecessor.id,
        { supersededByRowId: predecessor.id },
      ),
    ).rejects.toThrow("itself or form a cycle");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      predecessor.id,
      { supersededByRowId: successor.id },
    );
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        successor.id,
        { supersededByRowId: predecessor.id },
      ),
    ).rejects.toThrow("itself or form a cycle");
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
        successor.id,
      ]),
    ).rejects.toThrow("superseding record");
    expect((await listSourceTransactionRecords(ctx.db, {})).count).toBe(2);
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      predecessor.id,
      { supersededByRowId: null },
    );
    await deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
      successor.id,
    ]);
    expect((await listSourceTransactionRecords(ctx.db, {})).count).toBe(1);
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(2);
  });

  it("blocks deleting a revised observation when a transaction retains a predecessor reference", async () => {
    const evidence = rowInput({
      providerTransactionId: "synthetic-retained-charge",
      providerData: { version: 1 },
    });
    await record(ctx.db, ctx.actor, [evidence], {
      fingerprint: "synthetic-charge-original",
      rowCountDeclared: 1,
    });
    const original = (await listSourceTransactionRecords(ctx.db, {})).data[0]!;
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic settlement account",
      })
    ).output;
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: original.amount,
      postedDate: original.statementDate,
      sourceRefs: [
        { source: original.source, externalId: original.externalId },
      ],
    });
    await record(
      ctx.db,
      ctx.actor,
      [{ ...evidence, providerData: { version: 2 } }],
      {
        fingerprint: "synthetic-charge-revision",
        rowCountDeclared: 1,
      },
    );
    const records = (await listSourceTransactionRecords(ctx.db, {})).data;
    const revised = records.find(
      (row) => row.externalId !== original.externalId,
    )!;
    expect(revised.chargeKey).toBe(original.chargeKey);
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
        revised.id,
      ]),
    ).rejects.toThrow("settlement evidence");
    expect((await listSourceTransactionRecords(ctx.db, {})).count).toBe(2);
  });

  it("shares provider evidence across collection positions without reviving an older version after head deletion", async () => {
    const first = recordSourceTransactionRecordsInput.parse({
      import: importInput({
        fingerprint: "synthetic-position-first",
        observedAt: "2026-06-01T00:00:00Z",
        rowCountDeclared: 1,
      }),
      rows: [
        rowInput({
          rowPosition: 1,
          providerTransactionId: "synthetic-position-charge",
          providerData: { version: 1 },
        }),
      ],
    });
    await recordSourceTransactionRecords(ctx.db, first, ctx.actor);
    const original = (await listSourceTransactionRecords(ctx.db, {})).data[0]!;
    await recordSourceTransactionRecords(
      ctx.db,
      {
        ...first,
        import: {
          ...first.import,
          fingerprint: "synthetic-position-second",
          observedAt: "2026-06-02T00:00:00Z",
        },
        rows: [{ ...first.rows[0]!, rowPosition: 2 }],
      },
      ctx.actor,
    );
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toMatchObject(
      [{ id: original.id, rowPosition: 1 }],
    );
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(2);
    await recordSourceTransactionRecords(
      ctx.db,
      {
        ...first,
        import: {
          ...first.import,
          fingerprint: "synthetic-position-revision",
          observedAt: "2026-06-03T00:00:00Z",
        },
        rows: [{ ...first.rows[0]!, providerData: { version: 2 } }],
      },
      ctx.actor,
    );
    const head = (await listSourceTransactionRecords(ctx.db, {})).data.find(
      (row) => row.current,
    )!;
    expect(head.id).not.toBe(original.id);
    await deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
      head.id,
    ]);
    const beforeReplay = await getDb(ctx.db).select().from(auditLog);
    await recordSourceTransactionRecords(ctx.db, first, ctx.actor);
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toMatchObject(
      [{ id: original.id, current: false }],
    );
    expect(
      await getDb(ctx.db).select().from(transactionImportRecord),
    ).toHaveLength(3);
    expect(await getDb(ctx.db).select().from(auditLog)).toEqual(beforeReplay);
  });

  // Confirmed withdrawal is monotonic: an old collection cannot resurrect money.
  // Separate provider IDs also keep identical coexisting purchases independent.
  it("retains provider revisions and zero evidence without replaying a withdrawn head", async () => {
    const scope = {
      account: "synthetic-provider-account",
      from: "2026-05-01",
      to: "2026-05-31",
      visibility: "all",
    };
    const first = recordSourceTransactionRecordsInput.parse({
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
    await recordSourceTransactionRecords(ctx.db, first, ctx.actor);
    const initial = await listSourceTransactionRecords(ctx.db, {});
    expect(new Set(initial.data.map((row) => row.chargeKey)).size).toBe(3);
    const second = recordSourceTransactionRecordsInput.parse({
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
    expect(
      await recordSourceTransactionRecords(ctx.db, second, ctx.actor),
    ).toMatchObject({
      inserted: 1,
      revised: 1,
      withdrawn: 1,
      completed: true,
    });
    await recordSourceTransactionRecords(ctx.db, first, ctx.actor);
    const all = (await listSourceTransactionRecords(ctx.db, {})).data;
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
      recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
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
    const scope: NonNullable<TransactionImportInput["coverage"]> = {
      account: "synthetic-enriched-account",
      from: "2026-05-01",
      to: "2026-05-31",
      visibility: "all",
    };
    const enriched = recordSourceTransactionRecordsInput.parse({
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
      await recordSourceTransactionRecords(ctx.db, enriched, ctx.actor),
    ).toMatchObject({
      inserted: 1,
      revised: 1,
      completed: true,
    });
    const observations = (await listSourceTransactionRecords(ctx.db, {})).data;
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
    const separate = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(new Set(separate.map((row) => row.chargeKey)).size).toBe(2);
    expect(
      separate.filter((row) => row.current).map((row) => row.providerAccountId),
    ).toEqual(
      expect.arrayContaining([scope.account, "synthetic-other-account"]),
    );
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
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
      await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
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

  it.each(["v1", "v3"])(
    "replays historical %s unpositioned membership without moving ignored or booked ownership",
    async (identityVersion) => {
      const rows = [
        rowInput({ rowPosition: undefined }),
        rowInput({
          rowPosition: undefined,
          rawDescription: "SYNTHETIC BOOKED CHARGE",
        }),
      ];
      const fingerprint = "synthetic-historical-membership";
      await record(
        ctx.db,
        ctx.actor,
        rows.map((row, index) => ({ ...row, rowPosition: index + 1 })),
        { fingerprint },
      );
      // Retain both historical identity shapes and charge owners rather than
      // rehashing historical references into the current collection identity.
      for (const row of (await listSourceTransactionRecords(ctx.db, {})).data) {
        const legacyId = row.legacyExternalId;
        if (!legacyId) throw new Error("Synthetic historical identity missing");
        const historicalId =
          identityVersion === "v1"
            ? legacyId
            : `v3:${await sha256Hex(JSON.stringify(["monarch", "unpositioned", fingerprint, legacyId]))}`;
        await getDb(ctx.db)
          .update(sourceTransactionRecord)
          .set({
            externalId: historicalId,
            chargeKey: historicalId,
            legacyReference: legacyId,
            rowPosition: null,
          })
          .where(eq(sourceTransactionRecord.shortcode, row.id));
      }
      const historical = (await listSourceTransactionRecords(ctx.db, {})).data;
      const ignored = historical.find(
        (row) => row.rawDescription === rows[0]!.rawDescription,
      )!;
      const booked = historical.find(
        (row) => row.rawDescription === rows[1]!.rawDescription,
      )!;
      await updateSourceTransactionRecords(
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
          sourceRefs: [
            { source: booked.source, externalId: booked.externalId },
          ],
        })
      ).output;
      const before = (await listSourceTransactionRecords(ctx.db, {})).data;
      expect(
        await record(ctx.db, ctx.actor, rows, { fingerprint }),
      ).toMatchObject({
        inserted: 0,
        unchanged: 2,
        revised: 0,
        alreadyInThisBatch: 2,
        rowCountStored: 2,
      });
      expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual(
        before,
      );
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
      expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual(
        before,
      );
      await expect(
        record(ctx.db, ctx.actor, rows, {
          fingerprint: "synthetic-independent-collection",
        }),
      ).rejects.toThrow("stable physical row position");
      expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual(
        before,
      );
      expect(
        await record(
          ctx.db,
          ctx.actor,
          rows.map((row, index) => ({ ...row, rowPosition: index + 1 })),
          { fingerprint: "synthetic-independent-collection" },
        ),
      ).toMatchObject({ inserted: 2, revised: 0 });
      expect(
        new Set(
          (await listSourceTransactionRecords(ctx.db, {})).data.map(
            (row) => row.chargeKey,
          ),
        ).size,
      ).toBe(4);
    },
  );

  it("refuses unpositioned replay of indistinguishable physical collection members", async () => {
    const fingerprint = "synthetic-ambiguous-membership";
    await record(
      ctx.db,
      ctx.actor,
      [rowInput({ rowPosition: 1 }), rowInput({ rowPosition: 2 })],
      { fingerprint },
    );
    const before = (await listSourceTransactionRecords(ctx.db, {})).data;
    await expect(
      record(ctx.db, ctx.actor, [rowInput({ rowPosition: undefined })], {
        fingerprint,
      }),
    ).rejects.toThrow("physical positions");
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual(
      before,
    );
  });

  it("refuses conflicting historical position identities instead of matching content", async () => {
    const fingerprint = "synthetic-mispositioned-membership";
    const rows = [
      rowInput({ rowPosition: 1 }),
      rowInput({ rowPosition: 2, rawDescription: "SYNTHETIC SECOND CHARGE" }),
    ];
    await record(ctx.db, ctx.actor, rows, { fingerprint });
    const retained = (await listSourceTransactionRecords(ctx.db, {})).data;
    const first = retained.find((row) => row.rowPosition === 1)!;
    const second = retained.find((row) => row.rowPosition === 2)!;
    await getDb(ctx.db).execute(
      sql`UPDATE "SourceTransactionRecord" SET "externalId" = "legacyExternalId"`,
    );
    await getDb(ctx.db).execute(sql`
      UPDATE "SourceTransactionRecord" SET
        "externalId" = CASE WHEN "rowPosition" = 1 THEN ${second.externalId} ELSE ${first.externalId} END,
        "chargeKey" = CASE WHEN "rowPosition" = 1 THEN ${second.externalId} ELSE ${first.externalId} END
    `);
    const before = (await listSourceTransactionRecords(ctx.db, {})).data;
    await expect(
      record(ctx.db, ctx.actor, rows, { fingerprint }),
    ).rejects.toThrow(
      "An observation identity cannot change its original evidence",
    );
    expect((await listSourceTransactionRecords(ctx.db, {})).data).toEqual(
      before,
    );
  });

  // Opaque handles must survive replay, distinguish observations and keep
  // the paged roster/count aligned with the full-filtered-set footer.
  it("keeps public shortcodes across reimport and filtered pages", async () => {
    const rows = [1, 2, 3].map((rowPosition) => rowInput({ rowPosition }));
    const fingerprint = "read-handle-pages";
    await record(ctx.db, ctx.actor, rows, { fingerprint, rowCountDeclared: 3 });
    await record(ctx.db, ctx.actor, [rowInput({ rowPosition: 1 })], {
      fingerprint: "another-read-handle-export",
      rowCountDeclared: 1,
    });
    const filters = { source: "monarch", importFingerprint: fingerprint };
    const sort = { orderBy: "statementDate", direction: "asc" as const };
    const first = await listSourceTransactionRecords(
      ctx.db,
      filters,
      { pageIndex: 0, pageSize: 2 },
      sort,
    );
    const second = await listSourceTransactionRecords(
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
      expect(row.id).toMatch(/^STR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    expect(new Set(original.map((row) => row.externalId)).size).toBe(3);
    expect(
      (await getSourceTransactionRecordSummary(ctx.db, filters)).amountTotal,
    ).toBeCloseTo(3 * 128.5);
    expect(first.data.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(
      2 * 128.5,
    );
    await record(ctx.db, ctx.actor, rows, { fingerprint, rowCountDeclared: 3 });
    const repeated = await listSourceTransactionRecords(
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

    const listed = await listSourceTransactionRecords(ctx.db, {});
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
      rowPosition: 2,
      statementDate: "2026-05-08",
      rawDescription: "SECOND ORDER",
    });
    const first = await record(ctx.db, ctx.actor, [shared], {
      observedAt: "2026-06-01T00:00:00Z",
      rowCountDeclared: 1,
    });
    const original = (await listSourceTransactionRecords(ctx.db, {})).data[0];
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
    expect((await listTransactionImports(ctx.db)).count).toBe(1);
    const partial = await record(ctx.db, ctx.actor, [shared], overlapping);
    expect(partial).toMatchObject({
      inserted: 0,
      unchanged: 1,
      rowCountStored: 1,
      refreshed: 1,
    });
    expect(await findIncompleteTransactionImports(ctx.db)).toMatchObject([
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
    const beforeReplay = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(
      await record(ctx.db, ctx.actor, [shared, later], overlapping),
    ).toMatchObject({
      inserted: 0,
      unchanged: 2,
      refreshed: 0,
      rowCountStored: 2,
    });
    expect(await findIncompleteTransactionImports(ctx.db)).toEqual([]);
    // First-batch ownership and recorded membership name the same pair once.
    const members = await getDb(ctx.db).execute(
      sql`SELECT count(*)::int AS rows, count(DISTINCT (member."importId", member."statementRowId"))::int AS pairs FROM ${transactionImportMembers} member`,
    );
    expect(members.rows).toEqual([{ rows: 3, pairs: 3 }]);
    expect((await listTransactionImports(ctx.db)).data).toEqual(
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
    const all = await listSourceTransactionRecords(ctx.db, {});
    expect(all.count).toBe(2);
    expect(all.data).toEqual(beforeReplay);
    expect(
      all.data.find((row) => row.externalId === original?.externalId),
    ).toEqual({
      ...original,
      lastObservedAt: new Date(overlapping.observedAt),
      updatedAt: expect.any(Date),
    });
    expect(
      (
        await listSourceTransactionRecords(ctx.db, {
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
        await findSourceTransactionRecordDrift(ctx.db, {
          ...input,
          importFingerprint: "fp-shared-export",
        })
      ).candidates,
    ).toEqual([]);
    expect(
      (await findSourceTransactionRecordDrift(ctx.db, input)).candidates,
    ).toEqual([]);
    await record(
      ctx.db,
      ctx.actor,
      [rowInput({ rawDescription: "POSSIBLE REEXPORT" })],
      { fingerprint: "fp-separate-export", rowCountDeclared: 1 },
    );
    expect(
      (await findSourceTransactionRecordDrift(ctx.db, input)).candidates,
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
    expect((await listTransactionImports(ctx.db)).data).toHaveLength(0);
    expect((await listSourceTransactionRecords(ctx.db, {})).count).toBe(0);

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
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(row?.matchState).toBe("unmatched");

    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Test Card",
        identity: { kind: "credit_card", network: "amex" },
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

    // No write to SourceTransactionRecord: appending the ref on the transaction side is
    // what flips the row, which is why triage needs no new mutation surface.
    const afterMatch = (await listSourceTransactionRecords(ctx.db, {})).data[0];
    expect(afterMatch).toMatchObject({
      matchState: "matched",
      transactionId: transaction.id,
    });

    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
        row!.id,
      ]),
    ).rejects.toThrow("settlement evidence");
    expect((await listSourceTransactionRecords(ctx.db, {})).count).toBe(1);

    // A soft-deleted transaction is not evidence.
    await deleteThroughKernel(ctx.db, ctx.actor, "financialTransaction", [
      transaction.id,
    ]);
    const afterDelete = (await listSourceTransactionRecords(ctx.db, {}))
      .data[0];
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
    const matchedRow = (
      await listSourceTransactionRecords(ctx.db, {})
    ).data.find((row) => row.merchant === "Acme Supply");
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Test Card",
        identity: { kind: "credit_card", network: "amex" },
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

    const summary = await getSourceTransactionRecordSummary(ctx.db, {});
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
        (await getSourceTransactionRecordSummary(ctx.db, { matchState }))
          .amountTotal,
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

    const rows = (await listSourceTransactionRecords(ctx.db, {})).data;
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a!.externalId).not.toBe(b!.externalId);

    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Shared Card",
        identity: { kind: "credit_card", network: "amex" },
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
    const matched = await listSourceTransactionRecords(ctx.db, {
      matchState: "matched",
    });
    expect(matched.count).toBe(2);
    expect(matched.data).toHaveLength(2);
    expect(new Set(matched.data.map((row) => row.transactionId)).size).toBe(1);
  });

  it("rejects an ignore without reasoning, and a non-slug source", async () => {
    await record(ctx.db, ctx.actor, [rowInput()], { fingerprint: "fp-checks" });
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;

    // The CHECK, not application code, is what makes a reasonless ignore
    // impossible — dispositions carry their reasoning or do not exist.
    await expect(
      updateSourceTransactionRecords(
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
        INSERT INTO "TransactionImport" ("source", "label", "fingerprint")
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
    const before = await listSourceTransactionRecords(ctx.db, {});
    expect(before.count).toBe(2);

    // `""` is *supplied*, so a `!== undefined` check passes it — but the filter
    // builder skips falsy strings, leaving only `notDeleted`. Addressing every
    // row is never what a bulk disposition meant.
    for (const filter of [{ search: "" }, { source: "" }] as const) {
      await expect(
        updateSourceTransactionRecords(
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
    }

    const after = await listSourceTransactionRecords(ctx.db, {});
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
    const [row] = (await listSourceTransactionRecords(ctx.db, {})).data;
    // The stored columns reproduce the hash payload exactly, so the ledger can
    // audit its own identity function rather than trusting an opaque token.
    await expect(
      sourceTransactionRecordExternalId({
        source: row!.source,
        account: row!.accountDescriptor,
        date: row!.statementDate,
        amount: row!.providerAmount,
        originalStatement: row!.rawDescription,
      }),
    ).resolves.toBe(row!.legacyExternalId);
  });
});
