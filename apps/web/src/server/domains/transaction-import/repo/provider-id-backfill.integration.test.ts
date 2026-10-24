import {
  providerIdBackfillInput,
  providerIdBackfillOut,
  type ProviderIdBackfillInput,
  recordSourceTransactionRecordsInput,
} from "@cubby/schemas/source-transaction-record";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as freshness from "~/server/db/freshness/client";
import { getDb } from "~/server/db/helpers";
import {
  auditLog,
  sourceTransactionRecord,
  transactionImport,
} from "~/server/db/schema";
import * as calendar from "~/server/domains/calendar/repo/client";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import { recordSourceTransactionRecords } from "./source-transaction-record";
import { sourceTransactionRecordExternalId } from "./source-transaction-record-identity";

describe("CSV provider ID backfill", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  const fingerprint = "a".repeat(64);
  const originalRow = {
    rowPosition: 2,
    providerTransactionId: "synthetic-provider-1",
    providerAccountId: null,
    accountDescriptor: "Synthetic card",
    statementDate: "2026-01-01",
    providerAmount: -12,
    merchant: "Synthetic shop",
    rawDescription: "SYNTHETIC SHOP",
    sourceCategory: null,
    providerStatus: null,
    providerNotes: null,
    providerData: {
      fields: {
        Date: "2026-01-01",
        Merchant: "Synthetic shop",
        Account: "Synthetic card",
        "Original Statement": "SYNTHETIC SHOP",
        Amount: "-12",
        Id: "synthetic-provider-1",
      },
      csv: {
        fileSha256: fingerprint,
        sourceAmount: "-12",
        sourceSignConvention: "charges-negative",
      },
    },
  };
  const collectionInput = {
    source: "monarch",
    label: "Synthetic original.csv",
    fingerprint,
    observedAt: "2026-01-02T00:00:00.000Z",
    rowCountDeclared: 1,
  };
  const legacyRow = {
    ...originalRow,
    rowPosition: undefined,
    providerTransactionId: undefined,
    providerData: undefined,
  };

  const call = (action: string, input: Parameters<typeof callMcpTool>[2]) =>
    callMcpTool(
      createMcpServer(),
      action.startsWith("preview_") ? "finance_read" : "finance",
      { action, ...input },
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
    );

  async function fixture() {
    await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic card",
      sourceAliases: [
        { source: "monarch", alias: "Synthetic card", externalAccountId: null },
      ],
    });
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: collectionInput,
        rows: [{ ...legacyRow, rowPosition: 2 }],
      }),
      ctx.actor,
    );
    const externalId = await sourceTransactionRecordExternalId({
      source: "monarch",
      account: originalRow.accountDescriptor,
      date: originalRow.statementDate,
      amount: originalRow.providerAmount,
      originalStatement: originalRow.rawDescription,
    });
    await getDb(ctx.db).update(sourceTransactionRecord).set({
      externalId,
      chargeKey: externalId,
      legacyExternalId: null,
      legacyReference: externalId,
      rowPosition: null,
    });
    const [record] = await getDb(ctx.db).select().from(sourceTransactionRecord);
    const [collection] = await getDb(ctx.db).select().from(transactionImport);
    if (!record || !collection) throw new Error("Synthetic evidence missing");
    const input = providerIdBackfillInput.parse({
      recordId: record.shortcode,
      collectionId: collection.shortcode,
      source: "monarch",
      fingerprint,
      providerTransactionId: originalRow.providerTransactionId,
      originalRow,
      sourceProof: {
        kind: "authorized_local_csv",
        parser: "financial-evidence-import/parse_statement_csv.py",
        rowCount: 1,
        identityPositions: [2],
        providerIdPositions: [2],
      },
    });
    return { record, collection, input };
  }

  async function workSnapshot() {
    const result = await getDb(ctx.db).execute(sql`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Run" t) AS runs,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Job" t) AS jobs,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Assessment" t) AS assessments,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "AssessmentState" t) AS assessmentStates,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "FinancialTransaction" t) AS transactions,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "EntityExternalId" t) AS refs,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "Expense" t) AS expenses,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "ExpenseAttribution" t) AS attributions,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "FinancialTransactionAllocation" t) AS allocations,
      (SELECT jsonb_agg(to_jsonb(t)) FROM "TransactionImportRecord" t) AS memberships`);
    return result.rows;
  }

  async function preview(input: ProviderIdBackfillInput) {
    const result = await call("preview_provider_id_backfill", input);
    expect(result.isError).not.toBe(true);
    return providerIdBackfillOut.parse(result.structuredContent);
  }

  async function apply(input: ProviderIdBackfillInput) {
    const prepared = await preview(input);
    const result = await call("backfill_provider_id", {
      ...input,
      expectedGuard: prepared.guard,
    });
    expect(result.isError).not.toBe(true);
    return prepared;
  }

  async function replay(row: typeof legacyRow | typeof originalRow) {
    return recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: collectionInput,
        rows: [row],
      }),
      ctx.actor,
    );
  }

  async function acceptedBooking(
    record: typeof sourceTransactionRecord.$inferSelect,
  ) {
    const account = await getDb(ctx.db).query.financialAccount.findFirst();
    if (!account) throw new Error("Synthetic account missing");
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic booking member",
      kind: "member",
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic booking shop",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-01-01",
    });
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.shortcode,
      kind: "purchase",
      status: "posted",
      amount: 12,
      postedDate: "2026-01-01",
      sourceRefs: [{ source: "monarch", externalId: record.externalId }],
      allocations: [{ purchaseId: purchase.output.id, amount: 12 }],
    });
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic accepted line",
      purchaseId: purchase.output.id,
      date: "2026-01-01",
      cost: 12,
      trade: "other",
      lineKind: "principal",
      lineBasis: "allocation",
      economicRole: "vendor",
      beneficiaries: [{ partyId: member.output.id, weight: 3 }],
      funders: [{ partyId: member.output.id, weight: 2 }],
    });
  }

  it("public preview writes nothing; apply fills only the ID and audit proof without financial or scheduled work", async () => {
    const { record, input } = await fixture();
    await acceptedBooking(record);
    // Cloudflare notification ports are external seams; all writers stay real.
    const calendarDirty = vi
      .spyOn(calendar, "scheduleCalendarFeedDirty")
      .mockImplementation(() => undefined);
    const readerHints = vi
      .spyOn(freshness, "notifyDatabaseChanges")
      .mockResolvedValue(undefined);
    const before = await workSnapshot();
    const auditBefore = await getDb(ctx.db).execute(
      sql`SELECT count(*)::int AS n FROM "AuditLog"`,
    );
    const preview = await call("preview_provider_id_backfill", input);
    expect(preview.isError).not.toBe(true);
    const prepared = providerIdBackfillOut.parse(preview.structuredContent);
    expect(prepared.status).toBe("ready");
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual([
      record,
    ]);
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT count(*)::int AS n FROM "AuditLog"`,
      ),
    ).toMatchObject({ rows: auditBefore.rows });
    const { result: applied, auditIds } = await withAuditReceipts(() =>
      call("backfill_provider_id", { ...input, expectedGuard: prepared.guard }),
    );
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({ status: "applied" });
    expect(auditIds).toHaveLength(1);
    expect(readerHints).toHaveBeenCalledWith(
      expect.arrayContaining(["sourceTransactionRecord", "auditLog"]),
    );
    expect(calendarDirty).not.toHaveBeenCalled();
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual([
      { ...record, providerTransactionId: originalRow.providerTransactionId },
    ]);
    expect(await workSnapshot()).toEqual(before);
    const repeated = await call("backfill_provider_id", {
      ...input,
      expectedGuard: prepared.guard,
    });
    expect(repeated.structuredContent).toMatchObject({ status: "unchanged" });
    for (const row of [legacyRow, originalRow]) {
      const replay = await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: collectionInput,
          rows: [row],
        }),
        ctx.actor,
      );
      expect(replay).toMatchObject({
        inserted: 0,
        unchanged: 1,
        revised: 0,
        refreshed: 0,
      });
    }
    expect(await workSnapshot()).toEqual(before);
  });

  it.each([
    "fingerprint",
    "position",
    "Id",
    "normalization",
    "ambiguous identity",
    "duplicate ID",
    "incomplete row",
    "wrong source",
    "wrong collection",
  ])("holds %s proof without writes", async (fault) => {
    const { input } = await fixture();
    const altered = structuredClone(input);
    if (fault === "fingerprint") altered.fingerprint = "b".repeat(64);
    if (fault === "position") altered.originalRow.rowPosition = 3;
    if (fault === "Id")
      altered.originalRow.providerData.fields.Id = "synthetic-other-id";
    if (fault === "normalization")
      altered.originalRow.merchant = "invented normalization";
    if (fault === "ambiguous identity")
      altered.sourceProof.identityPositions = [2, 3];
    if (fault === "duplicate ID")
      altered.sourceProof.providerIdPositions = [2, 3];
    if (fault === "incomplete row")
      delete altered.originalRow.providerData.fields.Merchant;
    const payload =
      fault === "wrong source"
        ? { ...altered, source: "copilot" }
        : fault === "wrong collection"
          ? { ...altered, collectionId: "TIM-ZZZZ" }
          : altered;
    const before = await workSnapshot();
    const records = await getDb(ctx.db).select().from(sourceTransactionRecord);
    expect((await call("preview_provider_id_backfill", payload)).isError).toBe(
      true,
    );
    expect(
      (
        await call("backfill_provider_id", {
          ...payload,
          expectedGuard: "c".repeat(64),
        })
      ).isError,
    ).toBe(true);
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual(
      records,
    );
    expect(await workSnapshot()).toEqual(before);
  });

  it("holds a stale guard and a filled column without a committed proof", async () => {
    const { input, record } = await fixture();
    const prepared = await preview(input);
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ notes: "Synthetic intervening decision" })
      .where(eq(sourceTransactionRecord.id, record.id));
    const stale = await call("backfill_provider_id", {
      ...input,
      expectedGuard: prepared.guard,
    });
    expect(stale.isError).toBe(true);
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerTransactionId: input.providerTransactionId })
      .where(eq(sourceTransactionRecord.id, record.id));
    expect((await call("preview_provider_id_backfill", input)).isError).toBe(
      true,
    );
  });

  it.each([
    "withdrawn",
    "noncurrent",
    "deleted",
    "superseded",
    "membership",
    "collection changed",
  ])("holds %s targets", async (fault) => {
    const { input, record, collection } = await fixture();
    if (fault === "withdrawn")
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ withdrawnAt: new Date() });
    if (fault === "noncurrent")
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ current: false });
    if (fault === "deleted")
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ deletedAt: new Date() });
    if (fault === "superseded")
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ supersededByRowId: record.id });
    if (fault === "membership")
      await getDb(ctx.db).execute(
        sql`DELETE FROM "TransactionImportRecord" WHERE "importId"=${collection.id}`,
      );
    if (fault === "collection changed")
      await getDb(ctx.db)
        .update(transactionImport)
        .set({ rowCountDeclared: 2 });
    expect((await call("preview_provider_id_backfill", input)).isError).toBe(
      true,
    );
  });

  it("holds a provider ID owned in another collection", async () => {
    const { input } = await fixture();
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          ...collectionInput,
          fingerprint: "synthetic-other-collection",
        },
        rows: [{ ...originalRow, rawDescription: "SYNTHETIC OTHER CHARGE" }],
      }),
      ctx.actor,
    );
    expect((await call("preview_provider_id_backfill", input)).isError).toBe(
      true,
    );
  });

  it.each(["position", "provider ID"])(
    "checks committed %s claims across separate calls",
    async (claim) => {
      const { input } = await fixture();
      const secondRow = {
        ...originalRow,
        rowPosition: 3,
        providerTransactionId: "synthetic-provider-2",
        rawDescription: "SYNTHETIC SECOND SHOP",
        providerData: {
          ...originalRow.providerData,
          fields: {
            ...originalRow.providerData.fields,
            Id: "synthetic-provider-2",
            "Original Statement": "SYNTHETIC SECOND SHOP",
          },
        },
      };
      await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: collectionInput,
          rows: [
            { ...secondRow, providerTransactionId: null, providerData: null },
          ],
        }),
        ctx.actor,
      );
      const frozen = await sourceTransactionRecordExternalId({
        source: "monarch",
        account: secondRow.accountDescriptor,
        date: secondRow.statementDate,
        amount: secondRow.providerAmount,
        originalStatement: secondRow.rawDescription,
      });
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({
          externalId: frozen,
          chargeKey: frozen,
          legacyReference: frozen,
          legacyExternalId: null,
          rowPosition: null,
        })
        .where(
          eq(sourceTransactionRecord.rawDescription, secondRow.rawDescription),
        );
      await getDb(ctx.db)
        .update(transactionImport)
        .set({ rowCountDeclared: 2 });
      input.sourceProof.rowCount = 2;
      const firstPrepared = await apply(input);
      const second = await getDb(
        ctx.db,
      ).query.sourceTransactionRecord.findFirst({
        where: eq(sourceTransactionRecord.externalId, frozen),
      });
      if (!second) throw new Error("Synthetic second occurrence missing");
      const position = claim === "position" ? 2 : 3;
      const providerId =
        claim === "provider ID"
          ? originalRow.providerTransactionId
          : secondRow.providerTransactionId;
      const conflict = providerIdBackfillInput.parse({
        ...input,
        recordId: second.shortcode,
        providerTransactionId: providerId,
        originalRow: {
          ...secondRow,
          rowPosition: position,
          providerTransactionId: providerId,
          providerData: {
            ...secondRow.providerData,
            fields: { ...secondRow.providerData.fields, Id: providerId },
          },
        },
        sourceProof: {
          ...input.sourceProof,
          identityPositions: [position],
          providerIdPositions: [position],
        },
      });
      expect(
        (await call("preview_provider_id_backfill", conflict)).isError,
      ).toBe(true);
      await apply(
        providerIdBackfillInput.parse({
          ...input,
          recordId: second.shortcode,
          providerTransactionId: secondRow.providerTransactionId,
          originalRow: secondRow,
          sourceProof: {
            ...input.sourceProof,
            identityPositions: [3],
            providerIdPositions: [3],
          },
        }),
      );
      expect(
        (
          await call("backfill_provider_id", {
            ...input,
            expectedGuard: firstPrepared.guard,
          })
        ).structuredContent,
      ).toMatchObject({ status: "unchanged" });
    },
  );

  it.each([
    "account aliases",
    "known provider account",
    "accepted owners",
    "independent provider settlement",
  ])("holds conflicting %s", async (fault) => {
    const { input, record } = await fixture();
    const accounts = await getDb(ctx.db).query.financialAccount.findMany();
    const account = accounts[0];
    if (!account) throw new Error("Synthetic account missing");
    if (fault === "account aliases")
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic conflicting account",
        sourceAliases: [
          {
            source: "monarch",
            alias: "Synthetic card",
            externalAccountId: "synthetic-other-account",
          },
        ],
      });
    if (fault === "known provider account") {
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ providerAccountId: "synthetic-known-account" });
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic conflicting ID",
        sourceAliases: [
          {
            source: "monarch",
            alias: "Synthetic alternate label",
            externalAccountId: "synthetic-known-account",
          },
        ],
      });
    }
    if (fault === "accepted owners") {
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ legacyReference: "synthetic-other-frozen-ref" });
      for (const externalId of [
        record.externalId,
        "synthetic-other-frozen-ref",
      ])
        await createRepoEntity(ctx, "financialTransaction", {
          accountId: account.shortcode,
          kind: "purchase",
          status: "posted",
          amount: 12,
          postedDate: "2026-01-01",
          sourceRefs: [{ source: "monarch", externalId }],
        });
    }
    if (fault === "independent provider settlement")
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.shortcode,
        kind: "purchase",
        status: "posted",
        amount: 12,
        postedDate: "2026-01-01",
        sourceRefs: [
          { source: "monarch", externalId: input.providerTransactionId },
        ],
      });
    expect((await call("preview_provider_id_backfill", input)).isError).toBe(
      true,
    );
  });

  it.each(["missing", "malformed", "altered evidence"])(
    "refuses %s receipt-backed replay",
    async (fault) => {
      const { input } = await fixture();
      await apply(input);
      if (fault === "missing")
        await getDb(ctx.db)
          .delete(auditLog)
          .where(sql`${auditLog.changes} ? 'providerIdBackfill'`);
      if (fault === "malformed")
        await getDb(ctx.db)
          .update(auditLog)
          .set({
            changes: { providerIdBackfill: { from: null, to: "invalid" } },
          })
          .where(sql`${auditLog.changes} ? 'providerIdBackfill'`);
      for (const row of [legacyRow, originalRow]) {
        const incoming =
          fault === "altered evidence"
            ? { ...row, providerData: { unexpected: true } }
            : row;
        await expect(
          recordSourceTransactionRecords(
            ctx.db,
            recordSourceTransactionRecordsInput.parse({
              import: collectionInput,
              rows: [incoming],
            }),
            ctx.actor,
          ),
        ).rejects.toThrow(
          fault === "malformed"
            ? "The provider ID backfill audit proof is malformed."
            : row.providerTransactionId
              ? "One collection cannot contain contradictory revisions of the same provider record."
              : "New observations require a provider transaction ID or a stable physical row position.",
        );
      }
    },
  );

  it.each(["withdrawn", "newer", "deleted newer"])(
    "exact CSV replay cannot reactivate a %s head",
    async (state) => {
      const { input, record } = await fixture();
      await apply(input);
      if (state === "withdrawn")
        await getDb(ctx.db)
          .update(sourceTransactionRecord)
          .set({
            withdrawnAt: new Date("2026-02-01T00:00:00Z"),
            lastObservedAt: new Date("2026-02-01T00:00:00Z"),
          });
      else {
        await recordSourceTransactionRecords(
          ctx.db,
          recordSourceTransactionRecordsInput.parse({
            import: {
              ...collectionInput,
              fingerprint: "synthetic-newer",
              observedAt: "2026-02-01T00:00:00.000Z",
            },
            rows: [
              {
                ...originalRow,
                providerData: { revision: 2 },
                providerAmount: -14,
              },
            ],
          }),
          ctx.actor,
        );
        if (state === "deleted newer")
          await getDb(ctx.db)
            .update(sourceTransactionRecord)
            .set({ deletedAt: new Date() })
            .where(sql`${sourceTransactionRecord.id} <> ${record.id}`);
      }
      const before = await getDb(ctx.db)
        .select()
        .from(sourceTransactionRecord)
        .orderBy(sourceTransactionRecord.id);
      for (const row of [legacyRow, originalRow])
        await expect(replay(row)).resolves.toMatchObject({
          inserted: 0,
          unchanged: 1,
        });
      expect(
        await getDb(ctx.db)
          .select()
          .from(sourceTransactionRecord)
          .orderBy(sourceTransactionRecord.id),
      ).toEqual(before);
    },
  );

  it("future provider revision preserves the frozen charge and every accepted reference", async () => {
    const { input, record } = await fixture();
    const account = await getDb(ctx.db).query.financialAccount.findFirst();
    if (!account) throw new Error("Synthetic account missing");
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.shortcode,
      kind: "purchase",
      status: "posted",
      amount: 12,
      postedDate: "2026-01-01",
      sourceRefs: [{ source: "monarch", externalId: record.externalId }],
    });
    const before = await workSnapshot();
    await apply(input);
    expect(await workSnapshot()).toEqual(before);
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          ...collectionInput,
          fingerprint: "synthetic-provider-pull",
          observedAt: "2026-02-01T00:00:00.000Z",
        },
        rows: [
          {
            ...originalRow,
            providerAccountId: "synthetic-provider-account",
            providerData: { revision: 2 },
          },
        ],
      }),
      ctx.actor,
    );
    const rows = await getDb(ctx.db).select().from(sourceTransactionRecord);
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.chargeKey === record.chargeKey &&
          row.legacyReference === record.legacyReference,
      ),
    ).toBe(true);
    const after = await workSnapshot();
    expect(after[0]).toMatchObject({
      transactions: before[0]?.transactions,
      refs: before[0]?.refs,
      allocations: before[0]?.allocations,
      expenses: before[0]?.expenses,
    });
  });
});
