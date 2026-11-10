import type { sourceTransactionRecordRawOut } from "@cubby/schemas/entity-contracts/sourceTransactionRecord";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  sourceOccurrenceReviewState,
  sourceIdentityResolution,
  sourceOccurrenceClosure,
  type SourceIdentityResolution,
} from "@cubby/schemas/source-occurrence-fields";
import {
  recordSourceTransactionRecordsInput,
  sourceTransactionRecordMatchState,
  type TransactionImportInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { sourceTransactionRecordRepositoryReadSchema } from "~/entity/generated/entity-schema-bindings.sourceTransactionRecord.gen";
import {
  sourceHistoricalTransactionRows,
  sourceOccurrenceHasUnresolvedHistory,
} from "~/server/db/computed/source-occurrence-history-sql";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";
import {
  sourceOccurrence,
  financialAccount,
  financialTransaction,
  sourceObservationAnnotation,
  sourceTransactionRecord,
  transactionImportRecord,
  auditLog,
  financialEvidenceAlias,
} from "~/server/db/schema";
import {
  sourceObservations,
  sourceObservationsForPage,
  sourceObservationField,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { createMcpServer } from "~/server/mcp/server";
import {
  deleteThroughKernel,
  updateThroughKernel,
} from "~/server/testing/entity-kernel";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";

import { sourceOccurrenceRepository } from "./source-occurrence-read";
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
    await withTransaction(ctx.db, async (tx) => {
      const ordinary = await sourceOccurrenceRepository.repository.read(
        buildKernelContext(databaseForTransaction(tx), ctx.actor.userId),
        owners.map((owner) =>
          parseShortcodeFor("sourceOccurrence", owner.shortcode),
        ),
      );
      expect(ordinary.data).toHaveLength(2);
      expect(ordinary.data.every((row) => !Object.hasOwn(row, "closure"))).toBe(
        true,
      );
      await expect(
        sourceOccurrenceRepository.repository.read(
          buildKernelContext(databaseForTransaction(tx), ctx.actor.userId),
          owners.map((owner) =>
            parseShortcodeFor("sourceOccurrence", owner.shortcode),
          ),
          ["closure"],
        ),
      ).rejects.toThrow(
        "snapshot read outside a read-committed write transaction",
      );
    });
    const closureRead = await sourceOccurrenceRepository.repository.read(
      buildKernelContext(ctx.db, ctx.actor.userId),
      owners.map((owner) =>
        parseShortcodeFor("sourceOccurrence", owner.shortcode),
      ),
      ["closure"],
    );
    const closure = sourceOccurrenceClosure.parse(closureRead.data[0]?.closure);
    expect(closure.scope).toHaveLength(2);
    expect(
      closureRead.data.filter((row) => row.closure !== undefined),
    ).toHaveLength(1);
    expect(
      closure.sets.collections.every(
        (row) => !Object.hasOwn(Object(row), "notes"),
      ),
    ).toBe(true);
    expect(closure.sets.occurrences).toHaveLength(2);
    expect(closure.sets.observations).toHaveLength(2);
    expect(closure.sets.judgments).toEqual([]);
    expect(closure.sets.memberships).toHaveLength(2);
    expect(closure.sets.collections).toHaveLength(1);
    expect(closure.sets.transactions).toEqual([]);
    expect(closure.sets.effectiveExpenses).toEqual([]);
    const reader = buildKernelContext(ctx.db, ctx.actor.userId);
    const publicClosure = await callMcpTool(
      createMcpServer(),
      "entity_read",
      {
        action: "list",
        entity: "sourceOccurrence",
        filters: { ids: [closure.root] },
        fields: ["closure"],
      },
      kernelRequestContext(reader),
      { entityKernel: reader },
    );
    expect(publicClosure.isError).not.toBe(true);
    expect(publicClosure.structuredContent).toMatchObject({
      items: [
        {
          closure: {
            root: closure.root,
            scope: [closure.root],
            sets: { observations: [expect.any(Object)] },
          },
        },
      ],
    });

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
    const ordinary = await callMcpTool(
      createMcpServer(),
      "entity_read",
      {
        action: "get",
        entity: "sourceOccurrence",
        id: closure.root,
      },
      kernelRequestContext(reader),
      { entityKernel: reader },
    );
    expect(ordinary.isError).not.toBe(true);
    expect(ordinary.structuredContent).not.toHaveProperty("item.closure");
    const [seedOwner, siblingOwner] = owners;
    if (!seedOwner || !siblingOwner)
      throw new Error("Synthetic sibling owners missing");
    const seedAlias = (
      await getDb(ctx.db)
        .select()
        .from(financialEvidenceAlias)
        .where(eq(financialEvidenceAlias.occurrenceId, seedOwner.id))
    ).find((alias) => alias.kind === "externalId");
    if (!seedAlias) throw new Error("Synthetic root alias missing");
    const weakAccount = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic historical sibling account",
    });
    const weakHistory = await createRepoEntity(ctx, "financialTransaction", {
      accountId: weakAccount.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-05-04",
      amount: 128.5,
      sourceRefs: [],
    });
    const [weakBinding] = await getDb(ctx.db)
      .insert(financialEvidenceAlias)
      .values({
        source: seedAlias.source,
        kind: "transaction_ref",
        value: seedAlias.value,
        historicalTransactionId: weakHistory.entityId,
        provenanceKey: "synthetic-sibling-only-history",
        provenance: { kind: "retained_legacy_binding" },
        scopeEvidence: {},
      })
      .returning();
    if (!weakBinding) throw new Error("Synthetic sibling binding missing");
    const siblingClosure = sourceOccurrenceClosure.parse(
      (
        await sourceOccurrenceRepository.repository.read(
          reader,
          [parseShortcodeFor("sourceOccurrence", siblingOwner.shortcode)],
          ["closure"],
        )
      ).data[0]?.closure,
    );
    expect(siblingClosure.sets.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: weakHistory.entityId }),
      ]),
    );
    expect(siblingClosure.sets.aliases).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: weakBinding.id })]),
    );
    expect(siblingClosure.sets.occurrences).toEqual([
      expect.objectContaining({
        id: siblingOwner.id,
        acceptedTransactionId: null,
      }),
    ]);
    await getDb(ctx.db)
      .update(financialEvidenceAlias)
      .set({ deletedAt: new Date() })
      .where(eq(financialEvidenceAlias.id, weakBinding.id));

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
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({ currentObservationId: null });
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ rowPosition: null });
    await getDb(ctx.db)
      .update(transactionImportRecord)
      .set({ rowPosition: null, requestFingerprint: null });
    await getDb(ctx.db).update(sourceOccurrence).set({
      identityKind: "legacy",
      reviewState: "ready",
      physicalImportId: null,
      physicalPosition: null,
      disposition: "ignored",
      dispositionReason: "not_modeled",
      dispositionNote: "Explicit synthetic member ignore",
    });
    const ignoredOwners = await getDb(ctx.db).select().from(sourceOccurrence);
    const ignoredEvidence = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    const ignoredJudgments = await getDb(ctx.db)
      .select()
      .from(sourceObservationAnnotation);
    const moneyBefore = await getDb(ctx.db).execute(
      sql`SELECT (SELECT count(*) FROM "FinancialTransaction") AS transactions,(SELECT count(*) FROM "Expense") AS expenses`,
      "objects",
    );
    await expect(
      recordSourceTransactionRecords(ctx.db, input, ctx.actor),
    ).rejects.toThrow("unpositioned evidence");
    await expect(
      recordSourceTransactionRecords(
        ctx.db,
        {
          ...input,
          rows: input.rows.map((row) => ({
            ...row,
            accountDescriptor: ` ${row.accountDescriptor} `,
            rawDescription: row.rawDescription.toLowerCase(),
          })),
        },
        ctx.actor,
      ),
    ).rejects.toThrow("unpositioned evidence");
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual(
      ignoredEvidence,
    );
    expect(
      await getDb(ctx.db).select().from(sourceObservationAnnotation),
    ).toEqual(ignoredJudgments);
    expect(await getDb(ctx.db).select().from(sourceOccurrence)).toEqual(
      ignoredOwners,
    );
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT (SELECT count(*) FROM "FinancialTransaction") AS transactions,(SELECT count(*) FROM "Expense") AS expenses`,
        "objects",
      ),
    ).toEqual(moneyBefore);
    const [unresolved] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!unresolved) throw new Error("Synthetic unresolved evidence missing");
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic reviewed legacy account",
    });
    const target = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-05-04",
      amount: 128.5,
      sourceRefs: [],
    });
    const unresolvedOwner = ignoredOwners.find(
      (owner) => owner.shortcode === unresolved.chargeKey,
    );
    if (!unresolvedOwner) throw new Error("Synthetic unresolved owner missing");
    const review = {
      decision: "accept_existing",
      expectedDisposition: "ignored",
      expectedFactFingerprint: unresolved.factFingerprint,
      expectedOccurrenceVersion: unresolvedOwner.version,
      expectedAcceptedTransactionId: null,
      historicalTransactionIds: [],
      accountId: account.output.id,
      transactionId: target.output.id,
      note: "Member confirmed this source evidence belongs to the existing transaction",
      judgment: {
        disposition: "ignored",
        dispositionReason: "not_modeled",
        dispositionNote: "Explicit synthetic member ignore",
      },
    } satisfies SourceIdentityResolution;
    const other = (await listSourceTransactionRecords(ctx.db, {})).data.find(
      (row) => row.id !== unresolved.id,
    );
    if (!other) throw new Error("Synthetic second held observation missing");
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    const bulk = await callMcpTool(
      createMcpServer(),
      "entity",
      {
        action: "commands",
        resultDetail: "full",
        commands: [
          {
            action: "update",
            entity: "sourceTransactionRecord",
            id: other.id,
            data: {
              identityResolution: {
                ...review,
                expectedFactFingerprint: other.factFingerprint,
                expectedDisposition: "open",
                judgment: { disposition: "open" },
              },
            },
          },
          {
            action: "update",
            entity: "sourceTransactionRecord",
            id: unresolved.id,
            data: { identityResolution: review },
          },
        ],
      },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(bulk.isError).not.toBe(true);
    expect(bulk.structuredContent).toMatchObject({
      summary: { requested: 2, succeeded: 1, failed: 1 },
      results: [
        { index: 0, status: "failed" },
        { index: 1, status: "succeeded" },
      ],
    });
    const acceptedOwner = (
      await getDb(ctx.db).select().from(sourceOccurrence)
    ).find((owner) => owner.acceptedTransactionId === target.entityId);
    if (!acceptedOwner) throw new Error("Synthetic accepted owner missing");
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        other.id,
        {
          identityResolution: sourceIdentityResolution.parse({
            ...review,
            decision: "assign",
            expectedDisposition: "ignored",
            expectedFactFingerprint: other.factFingerprint,
            occurrenceId: parseShortcodeFor(
              "sourceOccurrence",
              acceptedOwner.shortcode,
            ),
            expectedTargetVersion: acceptedOwner.version,
          }),
        },
      ),
    ).rejects.toThrow(/Consolidate only|conflicting account/);
    expect(
      (await getDb(ctx.db).select().from(sourceOccurrence)).find(
        (owner) => owner.acceptedTransactionId === target.entityId,
      ),
    ).toMatchObject({
      identityKind: "legacy",
      disposition: "ignored",
      reviewState: "ready",
      acceptedTransactionId: target.entityId,
    });
    const assertReadProjection = async () => {
      const rows = await getDb(ctx.db).execute(
        sql`
        SELECT count(*)::int AS differences
        FROM "SourceTransactionRecord" r LEFT JOIN "SourceOccurrence" o ON o.id=r."occurrenceId"
        JOIN ${sourceObservations} projection ON projection.id=r.id
        WHERE projection."historicalTransactionIds" IS DISTINCT FROM ARRAY(
          SELECT history.code FROM (${sourceHistoricalTransactionRows(sql`r.id`, sql`ARRAY[r."occurrenceId"]::uuid[]`)}) history ORDER BY history.code
        ) OR projection."reviewState" IS DISTINCT FROM CASE
          WHEN o."reviewState"=${sourceOccurrenceReviewState.enum.ready} AND ${sourceOccurrenceHasUnresolvedHistory(sql`o.id`, sql`o."acceptedTransactionId"`)}
          THEN ${sourceOccurrenceReviewState.enum.ownership_conflict} ELSE o."reviewState" END
          OR projection."matchState" IS DISTINCT FROM ${sourceObservationField("matchState", "r")}
          OR projection."reviewState" IS DISTINCT FROM ${sourceObservationField("reviewState", "r")}`,
        "objects",
      );
      expect(rows).toEqual([{ differences: 0 }]);
      const roots = await getDb(ctx.db)
        .select({ id: sourceTransactionRecord.id })
        .from(sourceTransactionRecord);
      for (const root of roots) {
        const parity = await getDb(ctx.db).execute(
          sql`
          WITH page AS MATERIALIZED (
            SELECT id, "reviewState", "matchState", "historicalTransactionIds"
            FROM ${sourceObservationsForPage([root.id])} scoped
          ), canonical AS MATERIALIZED (
            SELECT id, "reviewState", "matchState", "historicalTransactionIds"
            FROM ${sourceObservations} whole WHERE id=${root.id}
          )
          SELECT (SELECT count(*)::int FROM page) AS rows,
            count(*) FILTER (WHERE page."reviewState" IS DISTINCT FROM canonical."reviewState"
              OR page."matchState" IS DISTINCT FROM canonical."matchState"
              OR page."historicalTransactionIds" IS DISTINCT FROM canonical."historicalTransactionIds")::int AS differences
          FROM page FULL JOIN canonical USING (id)
        `,
          "objects",
        );
        expect(parity).toEqual([{ rows: 1, differences: 0 }]);
      }
      const expected = await getDb(ctx.db).execute<
        Pick<
          z.infer<typeof sourceTransactionRecordRawOut>,
          "id" | "matchState" | "transactionId" | "historicalTransactionIds"
        >
      >(
        sql`SELECT shortcode AS id, "matchState", "transactionShortcode" AS "transactionId", "historicalTransactionIds"
          FROM ${sourceObservations} observed WHERE observed."deletedAt" IS NULL`,
      );
      const factKeys = [
        "externalId",
        "legacyExternalId",
        "chargeKey",
        "current",
        "withdrawnAt",
        "lastObservedAt",
        "updatedAt",
        "notes",
        "dispositionNote",
        "disposition",
        "dispositionReason",
        "accountId",
        "withdrawalImportId",
        "supersededByRowId",
      ] as const;
      const expectedFacts = await getDb(ctx.db)
        .select({
          id: sourceTransactionRecord.shortcode,
          ...Object.fromEntries(
            factKeys.map((key) => [key, sourceObservationField(key)]),
          ),
          accountId: sql`(SELECT shortcode FROM "FinancialAccount" WHERE id=${sourceObservationField("accountId")})`,
          withdrawalImportId: sql`(SELECT shortcode FROM "TransactionImport" WHERE id=${sourceObservationField("withdrawalImportId")})`,
          supersededByRowId: sql`(SELECT shortcode FROM "SourceTransactionRecord" successor WHERE successor.id=${sourceObservationField("supersededByRowId")})`,
        })
        .from(sourceTransactionRecord)
        .where(
          inArray(
            sourceTransactionRecord.shortcode,
            expected.rows.map((row) => row.id),
          ),
        );
      const complete = await sourceTransactionRecordScaffold.get(
        ctx.db,
        expectedFacts.map((row) => row.id),
      );
      for (const row of expectedFacts) {
        const expectedValues = new Map(Object.entries(row));
        const raw = complete.fieldReads?.get(row.id)?.raw;
        expect(raw).toBeDefined();
        expect(
          Object.fromEntries(factKeys.map((key) => [key, raw?.[key]])),
        ).toEqual(
          Object.fromEntries(
            factKeys.map((key) => [key, expectedValues.get(key)]),
          ),
        );
      }
      // Small pages must retain history supplied by observations outside their scope.
      for (
        let pageIndex = 0;
        pageIndex * 2 < expected.rows.length;
        pageIndex++
      ) {
        const page = await sourceTransactionRecordScaffold.read(ctx.db, {
          filters: {},
          sorts: [],
          pagination: { pageIndex, pageSize: 2 },
          projection: selectedListProjection(
            sourceTransactionRecordRepositoryReadSchema,
            ["id", "matchState", "transactionId", "historicalTransactionIds"],
          ),
        });
        expect(page.data).toHaveLength(
          Math.min(2, expected.rows.length - pageIndex * 2),
        );
        const pageIds = new Set(page.data.map((row) => row.id));
        expect(
          page.data
            .map((row) => ({
              id: row.id,
              matchState: row.matchState,
              transactionId: row.transactionId,
              historicalTransactionIds: row.historicalTransactionIds,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ).toEqual(
          expected.rows
            .filter((row) => pageIds.has(row.id))
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
      }
    };
    const [historicalBinding] = await getDb(ctx.db)
      .insert(financialEvidenceAlias)
      .values({
        source: unresolved.source,
        kind: "transaction_ref",
        value: unresolved.externalId,
        historicalTransactionId: target.entityId,
        provenanceKey: "synthetic-retained-history",
        provenance: { kind: "retained_legacy_binding" },
        scopeEvidence: {},
      })
      .returning();
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.every((row) =>
        row.historicalTransactionIds.includes(target.output.id),
      ),
    ).toBe(true);
    await assertReadProjection();
    const competing = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-05-04",
      amount: 128.5,
      sourceRefs: [],
    });
    await record(
      [
        rowInput({
          merchant: "Independent synthetic merchant",
          providerAmount: -47.25,
        }),
      ],
      {
        fingerprint: "synthetic-independent-ready-owner",
      },
    );
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.find(
        (item) => item.merchant === "Independent synthetic merchant",
      ),
    ).toMatchObject({ matchState: "unmatched", historicalTransactionIds: [] });
    const retainedJudgments = await getDb(ctx.db)
      .select()
      .from(sourceObservationAnnotation);
    expect(retainedJudgments).toHaveLength(ignoredJudgments.length);
    expect(
      retainedJudgments.filter((item) =>
        ignoredJudgments.some(
          (original) => original.observationId === item.observationId,
        ),
      ),
    ).toEqual(ignoredJudgments);
    const [conflict] = await getDb(ctx.db)
      .insert(financialEvidenceAlias)
      .values({
        source: unresolved.source,
        kind: "transaction_ref",
        value: unresolved.externalId,
        historicalTransactionId: competing.entityId,
        provenanceKey: "synthetic-competing-history",
        provenance: { kind: "retained_legacy_binding" },
        scopeEvidence: {},
      })
      .returning();
    if (!conflict) throw new Error("Synthetic competing binding missing");
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT "reviewState" FROM ${sourceObservations} r WHERE r."occurrenceId"=${acceptedOwner.id}`,
        "objects",
      ),
    ).toEqual([{ reviewState: "ownership_conflict" }]);
    await assertReadProjection();
    await getDb(ctx.db)
      .update(financialEvidenceAlias)
      .set({ deletedAt: new Date() })
      .where(eq(financialEvidenceAlias.id, conflict.id));
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT "reviewState" FROM ${sourceObservations} r WHERE r."occurrenceId"=${acceptedOwner.id}`,
        "objects",
      ),
    ).toEqual([{ reviewState: "ready" }]);
    await getDb(ctx.db)
      .update(financialEvidenceAlias)
      .set({ deletedAt: new Date() })
      .where(eq(financialEvidenceAlias.id, historicalBinding!.id));
    await assertReadProjection();
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.every(
        (row) => row.historicalTransactionIds.length === 0,
      ),
    ).toBe(true);
    expect(
      await getDb(ctx.db).select().from(sourceObservationAnnotation),
    ).toEqual(retainedJudgments);
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT count(*)::int AS count FROM "Expense"`,
        "objects",
      ),
    ).toEqual([{ count: 0 }]);

    const priorIds = new Set(
      (
        await getDb(ctx.db)
          .select({ id: sourceTransactionRecord.id })
          .from(sourceTransactionRecord)
      ).map((row) => row.id),
    );
    await record(
      Array.from({ length: 5 }, (_, index) =>
        rowInput({
          merchant: `Synthetic frontier ${index}`,
          rawDescription: `SYNTHETIC FRONTIER ${index}`,
          providerAmount: -(index + 1),
        }),
      ),
      { fingerprint: "synthetic-frontier-world" },
    );
    const fresh = (
      await getDb(ctx.db).select().from(sourceTransactionRecord)
    ).filter((row) => !priorIds.has(row.id));
    const [a, b, d, occurrenceOnly, fenceOnly] = fresh;
    if (!a || !b || !d || !occurrenceOnly || !fenceOnly)
      throw new Error("Synthetic frontier roots missing");
    await record(
      [
        rowInput({
          merchant: "Synthetic other-source frontier",
          providerAmount: -19,
        }),
      ],
      {
        source: "synthetic-frontier-other",
        fingerprint: "synthetic-other-source-frontier",
      },
    );
    let sequence = 0;
    const alias = (
      value: string,
      owner: typeof a | null,
      extra: Partial<typeof financialEvidenceAlias.$inferInsert> = {},
    ) => ({
      source: unresolved.source,
      kind: "retained_frontier",
      value,
      observationId: owner?.id ?? null,
      occurrenceId: owner?.occurrenceId ?? null,
      provenanceKey: `synthetic-frontier-${sequence++}`,
      provenance: { kind: "retained_legacy_binding" },
      scopeEvidence: {},
      ...extra,
    });
    // A sees B's direct K2 history through K, but cannot recurse through D.
    // Occurrence-only aliases root reads without acting as observation siblings.
    await getDb(ctx.db)
      .insert(financialEvidenceAlias)
      .values([
        alias("frontier-k", a, { occurrenceId: null }),
        alias("frontier-k", b, { deletedAt: new Date() }),
        alias("frontier-k2", b),
        alias("frontier-k2", d),
        alias("frontier-k3", d),
        alias("frontier-k2", null, {
          kind: "transaction_ref",
          historicalTransactionId: target.entityId,
        }),
        alias("frontier-k2", null, {
          historicalTransactionId: target.entityId,
        }),
        alias("frontier-k2", null, {
          historicalTransactionId: competing.entityId,
          deletedAt: new Date(),
        }),
        alias("frontier-k2", null, {
          source: "synthetic-frontier-other",
          historicalTransactionId: competing.entityId,
        }),
        alias("frontier-k3", null, {
          historicalTransactionId: competing.entityId,
        }),
        alias("frontier-k", null, {
          occurrenceId: occurrenceOnly.occurrenceId,
        }),
        alias("frontier-occurrence-evidence", occurrenceOnly),
        alias("frontier-occurrence-evidence", null, {
          historicalTransactionId: competing.entityId,
        }),
        alias("frontier-fence-only", null, {
          occurrenceId: fenceOnly.occurrenceId,
          historicalTransactionId: competing.entityId,
        }),
      ]);
    await getDb(ctx.db)
      .update(financialEvidenceAlias)
      .set({ occurrenceId: null })
      .where(eq(financialEvidenceAlias.observationId, fenceOnly.id));
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({ reviewState: "ready" })
      .where(eq(sourceOccurrence.id, fenceOnly.occurrenceId));
    const readFrontier = (id: typeof a.id) =>
      getDb(ctx.db).execute(
        sql`
      SELECT "reviewState", "historicalTransactionIds" FROM ${sourceObservationsForPage([id])} scoped
    `,
        "objects",
      );
    expect(await readFrontier(a.id)).toEqual([
      { reviewState: "ready", historicalTransactionIds: [target.output.id] },
    ]);
    expect(await readFrontier(b.id)).toEqual([
      {
        reviewState: "ownership_conflict",
        historicalTransactionIds: [
          target.output.id,
          competing.output.id,
        ].sort(),
      },
    ]);
    expect(await readFrontier(occurrenceOnly.id)).toEqual([
      {
        reviewState: "ownership_conflict",
        historicalTransactionIds: [
          target.output.id,
          competing.output.id,
        ].sort(),
      },
    ]);
    expect(await readFrontier(fenceOnly.id)).toEqual([
      { reviewState: "ownership_conflict", historicalTransactionIds: [] },
    ]);
    await assertReadProjection();
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({
        identityProof: sql`coalesce(${sourceOccurrence.identityProof}, '{}'::jsonb) || jsonb_build_object('resolvedHistoricalTransactionIds', jsonb_build_array(${target.entityId}::text))`,
      })
      .where(eq(sourceOccurrence.id, b.occurrenceId));
    expect(await readFrontier(b.id)).toEqual([
      {
        reviewState: "ready",
        historicalTransactionIds: [
          target.output.id,
          competing.output.id,
        ].sort(),
      },
    ]);
    await assertReadProjection();
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, competing.entityId));
    expect(await readFrontier(fenceOnly.id)).toEqual([
      { reviewState: "ready", historicalTransactionIds: [] },
    ]);
    await assertReadProjection();
  });

  it("holds conflicting provider account evidence and retains the closure boundary", async () => {
    await record([providerRow()]);
    await record(
      [
        providerRow({
          providerAccountId: "synthetic-other-account",
          providerData: {
            id: "synthetic-event",
            account_id: "synthetic-other-account",
          },
        }),
      ],
      { fingerprint: "synthetic-other-account" },
    );
    const owners = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.reviewState).toBe("identity_conflict");
    const root = owners[0];
    if (!root) throw new Error("Synthetic closure boundary owner missing");
    const [oversized] = await getDb(ctx.db)
      .insert(financialEvidenceAlias)
      .values({
        source: root.source,
        kind: "transaction_ref",
        value: "synthetic-byte-bound",
        occurrenceId: root.id,
        provenanceKey: "synthetic-byte-bound",
        provenance: { kind: "retained_legacy_binding" },
        scopeEvidence: { oversized: "x".repeat(1048577) },
      })
      .returning({ id: financialEvidenceAlias.id });
    await expect(
      sourceOccurrenceRepository.repository.read(
        buildKernelContext(ctx.db, ctx.actor.userId),
        [parseShortcodeFor("sourceOccurrence", root.shortcode)],
        ["closure"],
      ),
    ).rejects.toThrow(/one MiB/);
    if (!oversized) throw new Error("Synthetic byte boundary missing");
    await getDb(ctx.db)
      .delete(financialEvidenceAlias)
      .where(eq(financialEvidenceAlias.id, oversized.id));
    await getDb(ctx.db)
      .insert(financialEvidenceAlias)
      .values(
        Array.from({ length: 1001 }, (_, index) => ({
          source: root.source,
          kind: "transaction_ref",
          value: `synthetic-closure-overflow-${index}`,
          occurrenceId: root.id,
          provenanceKey: `synthetic-closure-overflow-${index}`,
          provenance: { kind: "retained_legacy_binding" },
          scopeEvidence: {},
        })),
      );
    const reader = buildKernelContext(ctx.db, ctx.actor.userId);
    await expect(
      sourceOccurrenceRepository.repository.read(
        reader,
        [parseShortcodeFor("sourceOccurrence", root.shortcode)],
        ["closure"],
      ),
    ).rejects.toThrow("one thousand rows");
    await record(
      Array.from({ length: 11 }, (_, index) =>
        rowInput({
          rowPosition: index + 1,
          merchant: "Synthetic closure boundary",
        }),
      ),
      { fingerprint: "synthetic-eleven-owner-boundary" },
    );
    const tooManyOwners = await getDb(ctx.db).select().from(sourceOccurrence);
    await expect(
      sourceOccurrenceRepository.repository.read(
        reader,
        tooManyOwners.map((owner) =>
          parseShortcodeFor("sourceOccurrence", owner.shortcode),
        ),
        ["closure"],
      ),
    ).rejects.toThrow("at most ten owners");
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
      (await listSourceTransactionRecords(ctx.db, {})).data.find(
        (row) => row.current,
      )?.id,
    ).toBe(successor.id);
    const reviewedOwners = await getDb(ctx.db).select().from(sourceOccurrence);
    const reviewedAudits = await getDb(ctx.db).select().from(auditLog);
    await record([providerRow()]);
    expect(await getDb(ctx.db).select().from(sourceOccurrence)).toEqual(
      reviewedOwners,
    );
    expect(await getDb(ctx.db).select().from(auditLog)).toEqual(reviewedAudits);
    for (const hold of ["identity_conflict", "ownership_conflict"] as const) {
      await getDb(ctx.db).update(sourceOccurrence).set({ reviewState: hold });
      await record(
        [providerRow({ providerNotes: `Synthetic retained ${hold}` })],
        { fingerprint: `synthetic-sticky-${hold}` },
      );
      expect(
        (await getDb(ctx.db).select().from(sourceOccurrence))[0]?.reviewState,
      ).toBe(hold);
      const next = (await listSourceTransactionRecords(ctx.db, {})).data.find(
        (row) => row.providerNotes === `Synthetic retained ${hold}`,
      );
      if (!next) throw new Error("Synthetic held revision missing");
      await updateSourceTransactionRecords(
        ctx.db,
        {
          selector: {
            source: original.source,
            externalIds: [original.externalId],
          },
          data: { supersededByExternalId: next.externalId },
        },
        ctx.actor,
      );
      expect(
        (await getDb(ctx.db).select().from(sourceOccurrence))[0]?.reviewState,
      ).toBe(hold);
    }
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
    ).rejects.toThrow("Retained source evidence");
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
    const linkedVendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic closure vendor",
    });
    const linkedPurchase = await createRepoEntity(ctx, "purchase", {
      vendorId: linkedVendor.output.id,
      date: "2026-05-04",
    });
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic closure Expense",
      trade: "other",
      date: "2026-05-04",
      cost: 128.5,
      costType: "materials",
      purchaseId: linkedPurchase.output.id,
      beneficiaries: [{ partyId: null, weight: 1 }],
    });
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "financialTransaction",
      transaction.id,
      {
        allocations: [{ purchaseId: linkedPurchase.output.id, amount: 128.5 }],
      },
    );
    const readBack = await sourceOccurrenceRepository.repository.read(
      buildKernelContext(ctx.db, ctx.actor.userId),
      [parseShortcodeFor("sourceOccurrence", row.chargeKey)],
      ["closure"],
    );
    const bundle = sourceOccurrenceClosure.parse(readBack.data[0]?.closure);
    expect(bundle.sets.transactions).toHaveLength(1);
    expect(bundle.sets.allocations).toHaveLength(1);
    expect(bundle.sets.purchases).toHaveLength(1);
    expect(bundle.sets.expenses).toHaveLength(1);
    expect(bundle.sets.recordedAttribution).toHaveLength(1);
    expect(bundle.sets.effectiveExpenses).toHaveLength(1);
    expect(bundle.sets.expenses[0]).toMatchObject({ cost: 128.5 });
    expect(bundle.sets.recordedAttribution[0]).toMatchObject({
      ledgerPartyId: null,
      weight: "1",
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

    await record([rowInput({ rawDescription: "SYNTHETIC RACE" })], {
      fingerprint: "synthetic-delete-race",
    });
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
    const violations = await getDb(ctx.db).execute(
      sql`
      -- includes-deleted: a concurrent acceptance must never leave a deleted accepted head.
      SELECT count(*)::int AS count FROM "SourceOccurrence" owner
      JOIN "SourceTransactionRecord" head ON head.id=owner."currentObservationId"
      WHERE owner."acceptedTransactionId" IS NOT NULL AND head."deletedAt" IS NOT NULL`,
      "objects",
    );
    expect(violations[0]).toMatchObject({ count: 0 });
    await deleteThroughKernel(ctx.db, ctx.actor, "financialTransaction", [
      transaction.id,
    ]);
    expect(
      (await listSourceTransactionRecords(ctx.db, {})).data.find(
        (observation) => observation.id === row.id,
      ),
    ).toMatchObject({ matchState: "held", transactionId: null });
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
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic reappearance account",
    });
    const [evidence] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!before || !evidence)
      throw new Error("Synthetic withdrawal evidence missing");
    const resolution = {
      decision: "distinct" as const,
      expectedDisposition: "open",
      expectedFactFingerprint: evidence.factFingerprint,
      expectedOccurrenceVersion: before.version,
      expectedAcceptedTransactionId: null,
      historicalTransactionIds: [],
      accountId: account.output.id,
      note: "Member confirmed source reappearance",
      judgment: { disposition: "open" as const },
    } satisfies SourceIdentityResolution;
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        evidence.id,
        { identityResolution: resolution },
      ),
    ).rejects.toThrow("positive source evidence");
    await recordSourceTransactionRecords(
      ctx.db,
      { ...first, complete: true },
      ctx.actor,
    );
    expect((await getDb(ctx.db).select().from(sourceOccurrence))[0]).toEqual(
      before,
    );
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
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      evidence.id,
      {
        identityResolution: {
          ...resolution,
          expectedOccurrenceVersion: after!.version,
        },
      },
    );
    expect(
      (await getDb(ctx.db).select().from(sourceOccurrence))[0],
    ).toMatchObject({
      reviewState: "ready",
      withdrawnAt: null,
      acceptedTransactionId: null,
    });
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT count(*)::int AS count FROM "Expense"`,
        "objects",
      ),
    ).toEqual([{ count: 0 }]);
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
      projection: selectedListProjection(
        sourceTransactionRecordRepositoryReadSchema,
        ["id", "source", "matchState"],
      ),
    });
    expect(projection.data[0]).not.toHaveProperty("providerData");
    // Saved views, facets and import reports must agree with the visible state.
    for (const state of sourceTransactionRecordMatchState.options) {
      const filtered = await sourceTransactionRecordScaffold.read(ctx.db, {
        filters: { matchState: [state] },
        sorts: [{ orderBy: "matchState", direction: "asc" }],
        pagination: { pageIndex: 0, pageSize: 10 },
      });
      expect(filtered.count).toBe(state === "unmatched" ? 2 : 0);
      expect(filtered.data.every((item) => item.matchState === state)).toBe(
        true,
      );
      expect(
        filtered.data.every((item) =>
          Array.isArray(item.historicalTransactionIds),
        ),
      ).toBe(true);
    }

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
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic projected account",
    });
    const successor = (
      await listSourceTransactionRecords(ctx.db, {})
    ).data.find((candidate) => candidate.id !== row.id);
    if (!successor) throw new Error("Synthetic projected successor missing");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      row.id,
      {
        accountId: account.output.id,
        supersededByRowId: successor.id,
      },
    );
    const kernel = buildKernelContext(ctx.db, ctx.actor.userId);
    const publicRead = await callMcpTool(
      createMcpServer(),
      "entity_read",
      {
        action: "get",
        entity: "sourceTransactionRecord",
        id: row.id,
        fields: ["fields.accountId", "fields.supersededByRowId"],
      },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(publicRead.isError).not.toBe(true);
    expect(publicRead.structuredContent).toMatchObject({
      item: {
        fields: {
          accountId: { current: { assignment: { value: account.output.id } } },
          supersededByRowId: {
            current: { assignment: { value: successor.id } },
          },
        },
      },
    });
  });
  it("consolidates reviewed legacy evidence into its provider event and replays the retired reservation", async () => {
    const legacyInput = inputFor(
      [
        rowInput({
          providerAccountId: "synthetic-account",
          providerData: { note: "Retained without raw identity proof" },
        }),
      ],
      {
        fingerprint: "synthetic-consolidate-legacy",
        observedAt: "2026-06-05T00:00:00Z",
      },
    );
    await recordSourceTransactionRecords(ctx.db, legacyInput, ctx.actor);
    const [legacy] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!legacy) throw new Error("Synthetic legacy record missing");
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic consolidation account",
    });
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      legacy.id,
      { accountId: account.output.id },
    );
    const money = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-05-04",
      amount: 128.5,
      sourceRefs: [],
    });
    const [legacyOwner] = await getDb(ctx.db).select().from(sourceOccurrence);
    if (!legacyOwner) throw new Error("Synthetic legacy owner missing");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      legacy.id,
      {
        identityResolution: {
          decision: "accept_existing",
          expectedDisposition: "open",
          expectedFactFingerprint: legacy.factFingerprint,
          expectedOccurrenceVersion: legacyOwner.version,
          expectedAcceptedTransactionId: null,
          historicalTransactionIds: [],
          accountId: account.output.id,
          transactionId: money.output.id,
          note: "Reviewed existing synthetic transaction",
          judgment: { disposition: "open" },
        },
      },
    );
    await record([providerRow()], {
      fingerprint: "synthetic-consolidate-provider",
      observedAt: "2026-06-04T00:00:00Z",
    });
    const provider = (await listSourceTransactionRecords(ctx.db, {})).data.find(
      (row) => row.id !== legacy.id,
    );
    if (!provider) throw new Error("Synthetic provider record missing");
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      provider.id,
      { accountId: account.output.id },
    );
    const owners = await getDb(ctx.db).select().from(sourceOccurrence);
    const original = owners.find(
      (owner) => owner.shortcode === legacy.chargeKey,
    );
    const target = owners.find(
      (owner) => owner.shortcode === provider.chargeKey,
    );
    if (!original || !target)
      throw new Error("Synthetic reviewed owners missing");
    expect(target.reviewState).toBe("ready");
    const beforeMoney = await getDb(ctx.db).execute(
      sql`SELECT to_jsonb(money) value FROM "FinancialTransaction" money`,
      "objects",
    );
    const review = {
      decision: "assign",
      expectedDisposition: "open",
      expectedFactFingerprint: legacy.factFingerprint,
      expectedOccurrenceVersion: original.version,
      expectedAcceptedTransactionId: money.output.id,
      historicalTransactionIds: [],
      accountId: account.output.id,
      occurrenceId: parseShortcodeFor("sourceOccurrence", target.shortcode),
      expectedTargetVersion: target.version,
      note: "Reviewed same synthetic bank event",
      judgment: { disposition: "open" },
    } satisfies SourceIdentityResolution;
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        legacy.id,
        {
          identityResolution: {
            ...review,
            expectedTargetVersion: target.version + 1,
          },
        },
      ),
    ).rejects.toThrow(/Consolidate only/);
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      legacy.id,
      { identityResolution: review },
    );
    const after = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(after.find((owner) => owner.id === target.id)).toMatchObject({
      currentObservationId: target.currentObservationId,
      acceptedTransactionId: money.entityId,
      reviewState: "ready",
    });
    expect(after.find((owner) => owner.id === original.id)).toMatchObject({
      currentObservationId: null,
      acceptedTransactionId: null,
      supersededByOccurrenceId: target.id,
      accountId: null,
    });
    const recordsBeforeReplay = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    expect(
      recordsBeforeReplay.every((row) => row.occurrenceId === target.id),
    ).toBe(true);
    const aliasesBeforeReplay = await getDb(ctx.db)
      .select()
      .from(financialEvidenceAlias);
    expect(aliasesBeforeReplay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: original.shortcode,
          historicalTransactionId: money.entityId,
          deletedAt: expect.any(Date),
        }),
      ]),
    );
    expect(
      after.find((owner) => owner.id === target.id)?.lastObservedAt,
    ).toEqual(original.lastObservedAt);
    const laterReceipt = await record([providerRow()], {
      fingerprint: "synthetic-consolidate-next",
      observedAt: "2026-06-06T00:00:00Z",
    });
    const laterMembers = await getDb(ctx.db)
      .select()
      .from(transactionImportRecord)
      .where(eq(transactionImportRecord.importId, laterReceipt.batchId!));
    expect(laterMembers.map((member) => member.statementRowId)).toEqual([
      target.currentObservationId,
    ]);
    await recordSourceTransactionRecords(ctx.db, legacyInput, ctx.actor);
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual(
      recordsBeforeReplay,
    );
    expect(await getDb(ctx.db).select().from(financialEvidenceAlias)).toEqual(
      aliasesBeforeReplay,
    );
    expect(
      await getDb(ctx.db).execute(
        sql`SELECT to_jsonb(money) value FROM "FinancialTransaction" money`,
        "objects",
      ),
    ).toEqual(beforeMoney);
    await expect(
      updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        legacy.id,
        { identityResolution: review },
      ),
    ).rejects.toThrow(/ownership changed|Consolidate only/);
  });
  it("joins an unambiguous same-source re-export and keeps duplicate positions separate", async () => {
    await record([rowInput()], { fingerprint: "synthetic-export-one" });
    await record([rowInput()], { fingerprint: "synthetic-export-two" });
    const owners = await getDb(ctx.db).select().from(sourceOccurrence);
    const observations = await getDb(ctx.db)
      .select()
      .from(sourceTransactionRecord);
    expect(owners).toHaveLength(1);
    expect(observations).toHaveLength(2);
    expect(
      observations.every((row) => row.occurrenceId === owners[0]?.id),
    ).toBe(true);
    await record([rowInput(), rowInput()], {
      fingerprint: "synthetic-export-duplicates",
    });
    expect(await getDb(ctx.db).select().from(sourceOccurrence)).toHaveLength(3);
    await expect(
      record([rowInput()], { fingerprint: "synthetic-export-two" }),
    ).resolves.toMatchObject({ alreadyInThisBatch: 1, inserted: 0 });
  });

  it("converges a Monarch id without account across collections and holds a conflicting account", async () => {
    await record([rowInput({ providerTransactionId: "synthetic-event" })], {
      fingerprint: "synthetic-unattested",
      observedAt: "2026-06-01T00:00:00Z",
    });
    await record([rowInput({ providerTransactionId: "synthetic-event" })], {
      fingerprint: "synthetic-unattested-repeat",
      observedAt: "2026-06-02T00:00:00Z",
    });
    await record([providerRow()], {
      fingerprint: "synthetic-attested",
      observedAt: "2026-06-03T00:00:00Z",
    });
    let owners = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      identityKind: "provider",
      identityScope: "provider:monarch",
      reviewState: "ready",
    });
    await record(
      [
        providerRow({
          providerAccountId: "synthetic-other",
          providerData: {
            id: "synthetic-event",
            account_id: "synthetic-other",
          },
        }),
      ],
      {
        fingerprint: "synthetic-conflict",
        observedAt: "2026-06-04T00:00:00Z",
      },
    );
    owners = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.reviewState).toBe("identity_conflict");
  });

  it("retires a deleted legacy reservation without losing its financial decision or blocking account removal", async () => {
    await record([rowInput()]);
    const [bankRecord] = (await listSourceTransactionRecords(ctx.db, {})).data;
    const [owner] = await getDb(ctx.db).select().from(sourceOccurrence);
    if (!bankRecord || !owner)
      throw new Error("Synthetic legacy fixture missing");
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic removable account",
    });
    await updateThroughKernel(
      ctx.db,
      ctx.actor,
      "sourceTransactionRecord",
      bankRecord.id,
      {
        accountId: account.output.id,
        disposition: "ignored",
        dispositionReason: "not_modeled",
        dispositionNote: "Keep this explicit financial decision",
      },
    );
    // A historical legacy row cannot be created by modern intake.
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({
        identityKind: "legacy",
        reviewState: "ready",
        physicalImportId: null,
        physicalPosition: null,
      })
      .where(eq(sourceOccurrence.id, owner.id));
    await deleteThroughKernel(ctx.db, ctx.actor, "sourceTransactionRecord", [
      bankRecord.id,
    ]);
    const [retired] = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(retired).toMatchObject({
      deletedAt: expect.any(Date),
      accountId: account.entityId,
      disposition: "ignored",
      dispositionNote: "Keep this explicit financial decision",
    });
    const [identity] = await getDb(ctx.db)
      .select()
      .from(entityIdentity)
      .where(eq(entityIdentity.id, owner.id));
    expect(identity?.deletedAt).toEqual(retired?.deletedAt);
    await deleteThroughKernel(ctx.db, ctx.actor, "financialAccount", [
      account.output.id,
    ]);
    const [deletedAccount] = await getDb(ctx.db)
      .select()
      .from(financialAccount)
      .where(eq(financialAccount.id, account.entityId));
    expect(deletedAccount?.deletedAt).toBeInstanceOf(Date);
  });

  it.each(["provider", "legacy alias"])(
    "keeps provider authority held while a replaced legacy owner retains accepted money through %s overlap",
    async (overlap) => {
      await record([rowInput(), rowInput()]);
      const legacy = (await listSourceTransactionRecords(ctx.db, {})).data;
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({ providerTransactionId: "synthetic-overlap" });
      const account = await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic overlap account",
      });
      const money = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-05-04",
        amount: 128.5,
        sourceRefs: [],
      });
      await record(
        [
          providerRow({
            providerTransactionId: "synthetic-overlap",
            providerData: {
              id: "synthetic-overlap",
              account_id: "synthetic-account",
            },
          }),
        ],
        { fingerprint: "synthetic-overlap-provider" },
      );
      await updateSourceTransactionRecords(
        ctx.db,
        {
          selector: { filter: { source: "monarch" } },
          data: { accountId: account.output.id },
        },
        ctx.actor,
      );
      const owners = await getDb(ctx.db).select().from(sourceOccurrence);
      const target = owners.find((owner) => owner.identityKind === "provider");
      const source = owners.find(
        (owner) => owner.shortcode === legacy[0]?.chargeKey,
      );
      const other = owners.find(
        (owner) => owner.shortcode === legacy[1]?.chargeKey,
      );
      if (!target?.currentObservationId || !source || !other || !legacy[0])
        throw new Error("Synthetic reviewed overlap missing");
      if (overlap === "legacy alias") {
        await getDb(ctx.db)
          .update(sourceOccurrence)
          .set({
            identityKind: "legacy",
            reviewState: "ready",
            physicalImportId: null,
            physicalPosition: null,
          })
          .where(eq(sourceOccurrence.id, source.id));
        await getDb(ctx.db)
          .update(sourceTransactionRecord)
          .set({ providerTransactionId: null })
          .where(
            sql`${sourceTransactionRecord.occurrenceId} IN (${source.id},${other.id})`,
          );
        await getDb(ctx.db)
          .insert(financialEvidenceAlias)
          .values(
            [source, other].map((owner) => ({
              source: "monarch",
              kind: "chargeKey",
              value: "synthetic-shared-legacy-key",
              occurrenceId: owner.id,
              observationId: owner.currentObservationId,
              provenanceKey: `synthetic-overlap:${owner.id}`,
              provenance: { kind: "synthetic_historical_key" },
              scopeEvidence: {},
            })),
          );
      }
      // Retained replacement history can still have an accepted reservation; it must fence readiness.
      await getDb(ctx.db)
        .update(sourceOccurrence)
        .set({
          acceptedTransactionId: money.entityId,
          supersededByOccurrenceId: target.id,
          replacementObservationId: target.currentObservationId,
        })
        .where(eq(sourceOccurrence.id, other.id));
      await updateThroughKernel(
        ctx.db,
        ctx.actor,
        "sourceTransactionRecord",
        legacy[0].id,
        {
          identityResolution: {
            decision: "assign",
            expectedDisposition: "open",
            expectedFactFingerprint: legacy[0].factFingerprint,
            expectedOccurrenceVersion: source.version,
            expectedAcceptedTransactionId: null,
            historicalTransactionIds: [],
            accountId: account.output.id,
            occurrenceId: parseShortcodeFor(
              "sourceOccurrence",
              target.shortcode,
            ),
            expectedTargetVersion: target.version,
            note: "Consolidate one reviewed legacy group only",
            judgment: { disposition: "open" },
          },
        },
      );
      const after = await getDb(ctx.db).select().from(sourceOccurrence);
      expect(after.find((owner) => owner.id === target.id)).toMatchObject({
        reviewState: "identity_conflict",
        acceptedTransactionId: null,
        currentObservationId: target.currentObservationId,
      });
      expect(after.find((owner) => owner.id === other.id)).toMatchObject({
        acceptedTransactionId: money.entityId,
      });
      const reader = buildKernelContext(ctx.db, ctx.actor.userId);
      const worklist = await callMcpTool(
        createMcpServer(),
        "entity_read",
        {
          action: "list",
          entity: "sourceOccurrence",
          filters: {
            ids: [source.shortcode],
            supersededByOccurrenceIdPresenceFilter: "none",
          },
        },
        kernelRequestContext(reader),
        { entityKernel: reader },
      );
      expect(worklist.isError).not.toBe(true);
      expect(worklist.structuredContent).toMatchObject({ items: [] });
      expect(await getSourceTransactionRecordSummary(ctx.db, {})).toMatchObject(
        {
          matched: 0,
          unmatched: 0,
        },
      );
    },
  );

  it("holds contradictory raw provider claims but not a display label", async () => {
    await record([
      rowInput({
        providerTransactionId: "synthetic-event",
        providerAccountId: "synthetic-account",
        providerData: {
          id: "synthetic-other-event",
          account_id: "synthetic-account",
        },
      }),
      rowInput({
        providerTransactionId: "synthetic-labelled-event",
        providerAccountId: "synthetic-account",
        providerData: {
          id: "synthetic-labelled-event",
          account_id: "synthetic-account",
          account: "Synthetic card",
        },
      }),
    ]);
    const owners = await getDb(ctx.db).select().from(sourceOccurrence);
    expect(
      Object.fromEntries(
        owners.map((owner) => [owner.providerIdentity, owner.reviewState]),
      ),
    ).toEqual({
      "synthetic-event": "identity_conflict",
      "synthetic-labelled-event": "ready",
    });
  });
});
