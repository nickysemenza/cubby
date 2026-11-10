import type { ActorContext } from "@cubby/schemas/context";
import { sourceOccurrenceIdentityKind } from "@cubby/schemas/source-occurrence-fields";
import type { RecordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { generateShortcode, moneyToMinor } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  sourceOccurrence,
  sourceTransactionRecord,
  transactionImport,
  transactionImportRecord,
  financialEvidenceAlias,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  sourceObservationColumns,
  sourceObservationFrom,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  sourceTransactionRecordExternalId,
  providerIdentityClaims,
} from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import {
  insertPayloadsWithIdentities,
  isEntityShortcodeCollision,
} from "~/server/entity-kernel/repo/entity-identity-writer";
import { constraintViolation } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { auditEvidenceRows } from "./intake-audit";
import {
  planSourceHeads,
  planAdoption,
  planWithdrawals,
  type planSourceIntake,
  type planIntakeReceipt,
} from "./source-intake-plan";

const consolidatedProof = z.object({ kind: z.literal("consolidated") });
const OBSERVED_AT_SKEW_MS = 5 * 60_000;

type Identity = {
  kind: "provider" | "positioned";
  scope: string;
  providerId: string | null;
  position: number | null;
};
const requiredIdentity = (identity: Identity | null): Identity => {
  if (identity === null)
    return constraintViolation(
      "A new observation requires proven source identity.",
    );
  return identity;
};
const identityKey = (identity: {
  kind: z.infer<typeof sourceOccurrenceIdentityKind>;
  scope: string;
  providerId: string | null;
  position: number | null;
}) =>
  JSON.stringify([
    identity.kind,
    identity.scope,
    identity.providerId,
    identity.position,
  ]);
const storedIdentity = (owner: typeof sourceOccurrence.$inferSelect) => ({
  kind: owner.identityKind,
  scope: owner.identityScope,
  providerId: owner.providerIdentity,
  position: owner.physicalPosition,
});

function provenIdentity(
  source: string,
  fingerprint: string,
  row: RecordSourceTransactionRecordsInput["rows"][number],
): Identity | null {
  const { accounts, providerIds } = providerIdentityClaims(row.providerData);
  if (
    source === "monarch" &&
    row.providerTransactionId &&
    row.providerAccountId &&
    accounts.length > 0 &&
    providerIds.length > 0 &&
    accounts.every((id) => id === row.providerAccountId) &&
    providerIds.every((id) => id === row.providerTransactionId)
  )
    return {
      kind: "provider",
      scope: `provider-account:${row.providerAccountId}`,
      providerId: row.providerTransactionId,
      position: null,
    };
  if (row.rowPosition !== undefined)
    return {
      kind: "positioned",
      scope: `collection:${fingerprint}`,
      providerId: null,
      position: row.rowPosition,
    };
  return null;
}

/**
 * An attested provider row whose transaction id, provider account and amount
 * equal every live observation of exactly one unproven owner proves that
 * owner's identity: it becomes the provider occurrence in place, keeping its
 * account, disposition and history. Any disagreement, a second owner or a
 * second incoming row leaves the ordinary identity conflict for review.
 */
async function loadAdoptionFacts(
  query: ReturnType<typeof unwrapDb>,
  source: string,
  prepared: ReadonlyArray<{
    key: string;
    identity: Identity | null;
    row: RecordSourceTransactionRecordsInput["rows"][number];
  }>,
  byKey: ReadonlyMap<string, typeof sourceOccurrence.$inferSelect>,
) {
  const incoming = prepared.filter(
    (row) =>
      row.identity?.kind === "provider" &&
      row.identity.providerId &&
      !byKey.has(row.key),
  );

  const antecedents = incoming.length
    ? await query
        .select({
          occurrenceId: sourceTransactionRecord.occurrenceId,
          providerTransactionId: sourceTransactionRecord.providerTransactionId,
          providerAccountId: sourceTransactionRecord.providerAccountId,
          amount: sourceTransactionRecord.amount,
          providerData: sourceTransactionRecord.providerData,
          deletedAt: sourceTransactionRecord.deletedAt,
        })
        .from(sourceTransactionRecord)
        .where(
          and(
            eq(sourceTransactionRecord.source, source),
            inArray(
              sourceTransactionRecord.providerTransactionId,
              incoming.map((row) => row.identity!.providerId!),
            ),
          ),
        )
    : [];
  const ownerSizes = new Map<string, number>();
  const antecedentOwnerIds = [
    ...new Set(antecedents.map((record) => record.occurrenceId)),
  ];
  if (antecedentOwnerIds.length)
    for (const record of await query
      .select({ occurrenceId: sourceTransactionRecord.occurrenceId })
      .from(sourceTransactionRecord)
      .where(inArray(sourceTransactionRecord.occurrenceId, antecedentOwnerIds)))
      ownerSizes.set(
        record.occurrenceId,
        (ownerSizes.get(record.occurrenceId) ?? 0) + 1,
      );
  return { incoming, antecedents, ownerSizes };
}

/** Frozen tuple for fact equality only; the migration emits these exact JSON bytes independently. */
const factTuple = (
  source: string,
  row: RecordSourceTransactionRecordsInput["rows"][number],
) => [
  source,
  row.providerTransactionId ?? null,
  row.providerAccountId ?? null,
  row.accountDescriptor,
  row.statementDate,
  moneyToMinor(row.providerAmount).toString(),
  moneyToMinor(-row.providerAmount).toString(),
  row.merchant,
  row.rawDescription,
  row.sourceCategory,
  row.providerStatus,
  row.providerNotes,
];

export async function prepareRows(input: RecordSourceTransactionRecordsInput) {
  const { source, fingerprint, coverage } = input.import;
  if (
    coverage &&
    input.rows.some(
      (row) =>
        (row.providerAccountId ?? row.accountDescriptor) !== coverage.account ||
        row.statementDate < coverage.from ||
        row.statementDate > coverage.to,
    )
  )
    constraintViolation(
      "Every observation must belong to the declared account and date window.",
    );
  const rows = await Promise.all(
    input.rows.map(async (row) => {
      const identity = provenIdentity(source, fingerprint, row);
      const facts = await sha256Hex(JSON.stringify(factTuple(source, row)));
      return {
        row,
        identity,
        key: identity
          ? identityKey(identity)
          : JSON.stringify(["retained", facts]),
        factFingerprint: facts,
        requestFingerprint: await sha256Hex(
          canonicalJson({
            factFingerprint: facts,
            providerData: row.providerData ?? null,
          }),
        ),
        externalId: `v3:${await sha256Hex(JSON.stringify([source, "observation", identity ? identityKey(identity) : null, facts]))}`,
        legacyExternalId: await sourceTransactionRecordExternalId({
          source,
          account: row.accountDescriptor,
          date: row.statementDate,
          amount: row.providerAmount,
          originalStatement: row.rawDescription,
        }),
      };
    }),
  );
  if (new Set(rows.map((row) => row.key)).size !== rows.length)
    constraintViolation(
      "One collection cannot contain contradictory or repeated versions of one proven provider identity.",
    );
  return rows;
}

async function insertOccurrences(
  tx: DrizzleTransaction,
  rows: Omit<typeof sourceOccurrence.$inferInsert, "shortcode">[],
) {
  if (!rows.length) return [];
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await unwrapDb(tx).transaction((nested) =>
        insertPayloadsWithIdentities(
          nested,
          sourceOccurrence,
          "sourceOccurrence",
          rows.map((row) => ({
            ...row,
            shortcode: generateShortcode("sourceOccurrence"),
          })),
        ),
      );
    } catch (error) {
      if (
        !isEntityShortcodeCollision(error, "SourceOccurrence") ||
        attempt === 9
      )
        throw error;
    }
  }
  throw new Error("Failed to mint source occurrence identities");
}
async function insertObservations(
  tx: DrizzleTransaction,
  rows: Omit<typeof sourceTransactionRecord.$inferInsert, "shortcode">[],
) {
  if (!rows.length) return [];
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await unwrapDb(tx).transaction((nested) =>
        insertPayloadsWithIdentities(
          nested,
          sourceTransactionRecord,
          "sourceTransactionRecord",
          rows.map((row) => ({
            ...row,
            shortcode: generateShortcode("sourceTransactionRecord"),
          })),
        ),
      );
    } catch (error) {
      if (
        !isEntityShortcodeCollision(error, "SourceTransactionRecord") ||
        attempt === 9
      )
        throw error;
    }
  }
  throw new Error("Failed to mint source observation identities");
}

/** Intake changes evidence/head state only. Unknown revision order never changes accepted money. */
export async function lockAndLoadSourceIntake(
  tx: DrizzleTransaction,
  input: RecordSourceTransactionRecordsInput,
  prepared: Awaited<ReturnType<typeof prepareRows>>,
) {
  const query = unwrapDb(tx);
  const { source } = input.import;
  await lockFinancialEvidenceKeys(tx, "source", [`intake:${source}`]);
  const [existingBatch] = await query
    .select()
    .from(transactionImport)
    .where(
      and(
        eq(transactionImport.source, source),
        eq(transactionImport.fingerprint, input.import.fingerprint),
      ),
    )
    .limit(1);
  if (existingBatch?.deletedAt)
    constraintViolation(
      "This original collection is tombstoned; its fingerprint remains reserved.",
    );
  const observedAt = input.import.observedAt
    ? new Date(input.import.observedAt)
    : (existingBatch?.observedAt ?? new Date());
  // A future observation time would make every later real observation
  // compare as older. Retained collections replay their stored time.
  const now = Date.now();
  if (!existingBatch && observedAt.getTime() > now + OBSERVED_AT_SKEW_MS)
    constraintViolation(
      `observedAt ${observedAt.toISOString()} is later than server time ${new Date(now).toISOString()}; send when the evidence was observed.`,
    );
  if (
    existingBatch &&
    (existingBatch.observedAt.getTime() !== observedAt.getTime() ||
      existingBatch.rowCountDeclared !== input.import.rowCountDeclared ||
      canonicalJson(jsonSnapshot.parse(existingBatch.coverage)) !==
        canonicalJson(input.import.coverage ?? null))
  )
    constraintViolation(
      "A collection's observation time, count and scope are immutable; resume its exact retained request.",
    );
  const members = existingBatch
    ? await query
        .select({
          membership: transactionImportRecord,
          observation: sourceTransactionRecord,
          legacyAlias: sql<
            string | null
          >`(SELECT retained.value FROM "FinancialEvidenceAlias" retained
        WHERE retained."observationId"=${sourceTransactionRecord.id} AND retained.value LIKE 'v1:%' ORDER BY retained.id LIMIT 1)`,
        })
        .from(transactionImportRecord)
        .innerJoin(
          sourceTransactionRecord,
          eq(
            sourceTransactionRecord.id,
            transactionImportRecord.statementRowId,
          ),
        )
        .where(eq(transactionImportRecord.importId, existingBatch.id))
    : [];
  const providerIds = [
    ...new Set([
      ...prepared.flatMap((row) =>
        row.identity?.providerId ? [row.identity.providerId] : [],
      ),
      ...input.confirmedWithdrawals,
    ]),
  ];
  const scopes = [
    ...new Set(
      prepared.flatMap((row) => (row.identity ? [row.identity.scope] : [])),
    ),
  ];
  const adoptableIds = [
    ...new Set(
      prepared.flatMap((row) =>
        row.identity?.kind === "provider" && row.identity.providerId
          ? [row.identity.providerId]
          : [],
      ),
    ),
  ];
  const possibleOwners = await query
    .select()
    .from(sourceOccurrence)
    .where(
      and(
        eq(sourceOccurrence.source, source),
        or(
          scopes.length
            ? inArray(sourceOccurrence.identityScope, scopes)
            : undefined,
          providerIds.length
            ? inArray(sourceOccurrence.providerIdentity, providerIds)
            : undefined,
          adoptableIds.length
            ? and(
                eq(sourceOccurrence.identityKind, "unproven"),
                inArray(
                  sourceOccurrence.id,
                  query
                    .select({ id: sourceTransactionRecord.occurrenceId })
                    .from(sourceTransactionRecord)
                    .where(
                      and(
                        eq(sourceTransactionRecord.source, source),
                        inArray(
                          sourceTransactionRecord.providerTransactionId,
                          adoptableIds,
                        ),
                      ),
                    ),
                ),
              )
            : undefined,
        ) ?? sql`false`,
      ),
    );
  const redirectIds = possibleOwners.flatMap((owner) =>
    consolidatedProof.safeParse(owner.identityProof).success &&
    owner.supersededByOccurrenceId
      ? [owner.supersededByOccurrenceId]
      : [],
  );
  if (redirectIds.length)
    possibleOwners.push(
      ...(await query
        .select()
        .from(sourceOccurrence)
        .where(inArray(sourceOccurrence.id, redirectIds))),
    );
  const byKey = new Map(
    possibleOwners.map((owner) => [identityKey(storedIdentity(owner)), owner]),
  );
  const relevant = possibleOwners.filter(
    (owner) =>
      prepared.some((row) => row.key === identityKey(storedIdentity(owner))) ||
      input.confirmedWithdrawals.includes(owner.providerIdentity ?? "") ||
      redirectIds.includes(owner.id) ||
      owner.identityKind === "unproven",
  );
  await lockFinancialEvidenceKeys(
    tx,
    "reviewed-booking",
    relevant.flatMap((owner) =>
      owner.acceptedTransactionId
        ? [`transaction:${owner.acceptedTransactionId}`]
        : [],
    ),
  );
  const targetIds = [
    ...new Set(
      relevant.flatMap((owner) =>
        owner.acceptedTransactionId ? [owner.acceptedTransactionId] : [],
      ),
    ),
  ];
  const locked = relevant.length
    ? await query
        .select()
        .from(sourceOccurrence)
        .where(
          or(
            inArray(
              sourceOccurrence.id,
              relevant.map((owner) => owner.id),
            ),
            targetIds.length
              ? inArray(sourceOccurrence.acceptedTransactionId, targetIds)
              : undefined,
          ),
        )
        .orderBy(sourceOccurrence.id)
        .for("update")
    : [];
  for (const owner of locked) {
    if (
      relevant.some(
        (before) =>
          before.id === owner.id &&
          before.acceptedTransactionId !== owner.acceptedTransactionId,
      )
    )
      constraintViolation(
        "Accepted ownership changed before the source lock; retry intake.",
      );
    if (owner.source === source)
      byKey.set(identityKey(storedIdentity(owner)), owner);
  }
  for (const reservation of locked) {
    if (consolidatedProof.safeParse(reservation.identityProof).success) {
      const survivor = locked.find(
        (owner) => owner.id === reservation.supersededByOccurrenceId,
      );
      if (!survivor)
        return constraintViolation(
          "A consolidated source reservation has no survivor.",
        );
      if (survivor.deletedAt || survivor.source !== reservation.source)
        constraintViolation(
          "A consolidated source reservation has no current survivor.",
        );
      byKey.set(identityKey(storedIdentity(reservation)), survivor);
    }
  }
  const adoptionFacts = await loadAdoptionFacts(query, source, prepared, byKey);
  const adopted = planAdoption(source, locked, observedAt, adoptionFacts);
  for (const [key, owner] of adopted) byKey.set(key, owner);
  if (existingBatch)
    await query
      .select({ id: transactionImport.id })
      .from(transactionImport)
      .where(eq(transactionImport.id, existingBatch.id))
      .for("update");
  const ownerIds = locked.map((owner) => owner.id);
  const retained = ownerIds.length
    ? await query
        .select()
        .from(sourceTransactionRecord)
        .where(inArray(sourceTransactionRecord.occurrenceId, ownerIds))
        .orderBy(sourceTransactionRecord.createdAt, sourceTransactionRecord.id)
    : [];
  return {
    source,
    existingBatch,
    observedAt,
    members,
    byKey,
    locked,
    adopted,
    retained,
  };
}

type Loaded = Awaited<ReturnType<typeof lockAndLoadSourceIntake>>;
export async function applySourceIntake(
  tx: DrizzleTransaction,
  input: RecordSourceTransactionRecordsInput,
  actor: ActorContext,
  prepared: Awaited<ReturnType<typeof prepareRows>>,
  loaded: Loaded,
  plan: ReturnType<typeof planSourceIntake>,
  base: ReturnType<typeof planIntakeReceipt>,
) {
  const query = unwrapDb(tx);
  const {
    source,
    existingBatch,
    observedAt,
    members,
    byKey,
    locked,
    adopted,
    retained,
  } = loaded;
  const { chosen, novel } = plan;
  await ensureExternalSources(tx, [source]);
  const batch =
    existingBatch ??
    (await insertWithShortcode(tx, "transactionImport", {
      ...input.import,
      observedAt,
      coverage: input.import.coverage ?? null,
    }));
  for (const owner of adopted.values())
    await query
      .update(sourceOccurrence)
      .set({
        identityKind: owner.identityKind,
        identityScope: owner.identityScope,
        providerIdentity: owner.providerIdentity,
        identityProof: owner.identityProof,
        reviewState: owner.reviewState,
      })
      .where(
        and(
          eq(sourceOccurrence.id, owner.id),
          eq(sourceOccurrence.identityKind, "unproven"),
        ),
      );
  const fresh = chosen.filter(
    (row) => !row.owner && row.incoming.identity !== null,
  );
  const createdOwners = await insertOccurrences(
    tx,
    fresh.map(({ incoming }) => ({
      source,
      identityKind: requiredIdentity(incoming.identity).kind,
      identityScope: requiredIdentity(incoming.identity).scope,
      providerIdentity: requiredIdentity(incoming.identity).providerId,
      physicalImportId:
        requiredIdentity(incoming.identity).kind === "positioned"
          ? batch.id
          : null,
      physicalPosition: requiredIdentity(incoming.identity).position,
      identityProof:
        requiredIdentity(incoming.identity).kind === "provider"
          ? {
              kind: "raw_provider_ids",
              source,
              account: requiredIdentity(incoming.identity).scope.slice(
                "provider-account:".length,
              ),
              provider: requiredIdentity(incoming.identity).providerId!,
            }
          : {
              kind: "original_collection_position",
              source,
              fingerprint: input.import.fingerprint,
              position: requiredIdentity(incoming.identity).position!,
            },
      lastObservedAt: observedAt,
    })),
  );
  createdOwners.forEach((owner) =>
    byKey.set(identityKey(storedIdentity(owner)), owner),
  );
  const createdObservations = await insertObservations(
    tx,
    novel.map(({ incoming }) => ({
      ...incoming.row,
      batchId: batch.id,
      source,
      occurrenceId: byKey.get(incoming.key)!.id,
      factFingerprint: incoming.factFingerprint,
      providerTransactionId: incoming.row.providerTransactionId ?? null,
      providerAccountId: incoming.row.providerAccountId ?? null,
      providerData: incoming.row.providerData ?? null,
      amount: moneyToMinor(-incoming.row.providerAmount),
      providerAmount: moneyToMinor(incoming.row.providerAmount),
    })),
  );
  if (createdObservations.length)
    await query.insert(financialEvidenceAlias).values(
      createdObservations.flatMap((observation) => {
        const incoming = prepared.find(
          (row) =>
            byKey.get(row.key)?.id === observation.occurrenceId &&
            row.factFingerprint === observation.factFingerprint,
        )!;
        return [
          { kind: "externalId", value: incoming.externalId },
          { kind: "legacyExternalId", value: incoming.legacyExternalId },
        ].map((alias) => ({
          ...alias,
          source,
          observationId: observation.id,
          occurrenceId: observation.occurrenceId,
          provenanceKey: `observation:${observation.id}:${alias.kind}`,
          provenance: { kind: "source_observation" },
          scopeEvidence: {
            identityKind: requiredIdentity(incoming.identity).kind,
            scope: requiredIdentity(incoming.identity).scope,
          },
        }));
      }),
    );
  const incomingRows = requestedRows(
    fresh.map(({ incoming }) => ({
      key: incoming.key,
      reference: incoming.legacyExternalId,
      provider: incoming.row.providerTransactionId ?? null,
      owner: byKey.get(incoming.key)!.id,
      kind: requiredIdentity(incoming.identity).kind,
    })),
    {
      key: "text",
      reference: "text",
      provider: "text",
      owner: "uuid",
      kind: "text",
    },
    "incoming",
  );
  const overlapKeys = new Set(
    fresh.length
      ? (
          await query.execute<{ key: string }>(sql`
    -- includes-deleted: unknown historical scope and cross-collection overlap only block automatic authority.
    SELECT DISTINCT incoming.key FROM ${incomingRows.from}
    JOIN "FinancialEvidenceAlias" alias ON alias.source=${source} AND alias.value=incoming.reference
    LEFT JOIN "SourceTransactionRecord" antecedent ON antecedent.id=alias."observationId"
    WHERE incoming.kind=${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.positioned)} AND (antecedent."batchId"<>${batch.id}::uuid OR (antecedent.id IS NULL AND alias."historicalTransactionId" IS NOT NULL))
    UNION
    SELECT DISTINCT incoming.key FROM ${incomingRows.from}
    JOIN "SourceTransactionRecord" antecedent ON antecedent.source=${source} AND antecedent."providerTransactionId"=incoming.provider
    LEFT JOIN "SourceOccurrence" prior ON prior.id=antecedent."occurrenceId"
    WHERE incoming.provider IS NOT NULL AND antecedent."batchId"<>${batch.id}::uuid AND antecedent."occurrenceId" IS DISTINCT FROM incoming.owner
      AND (prior.id IS NULL OR prior."identityKind"<>${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.provider)})`)
        ).rows.map((row) => row.key)
      : [],
  );
  const headChanges = planSourceHeads({
    chosen,
    byKey,
    createdObservations,
    retained,
    adopted,
    overlapKeys,
    observedAt,
  });
  const requestedChanges = requestedRows(
    headChanges.map((row) => ({
      id: row.id,
      head: row.currentObservationId,
      state: row.reviewState,
      observed: row.lastObservedAt.toISOString(),
      version: row.version,
    })),
    {
      id: "uuid",
      head: "uuid",
      state: "text",
      observed: "text",
      version: "int",
    },
    "change",
  );
  const afterOwners = headChanges.length
    ? await query
        .update(sourceOccurrence)
        .set({
          currentObservationId: sql`change.head`,
          reviewState: sql`change.state`,
          lastObservedAt: sql`change.observed::timestamp`,
          version: sql`change.version`,
        })
        .from(requestedChanges.from)
        .where(eq(sourceOccurrence.id, sql`change.id`))
        .returning()
    : [];
  const memberships = chosen.map((row) => ({
    importId: batch.id,
    statementRowId: (
      row.observation ??
      createdObservations.find(
        (saved) =>
          saved.occurrenceId === byKey.get(row.incoming.key)?.id &&
          saved.factFingerprint === row.incoming.factFingerprint,
      )!
    ).id,
    rowPosition: row.incoming.row.rowPosition ?? null,
    requestFingerprint: row.incoming.requestFingerprint,
  }));
  if (memberships.length)
    await query
      .insert(transactionImportRecord)
      .values(memberships)
      .onConflictDoUpdate({
        target: [
          transactionImportRecord.importId,
          transactionImportRecord.statementRowId,
        ],
        set: {
          rowPosition: sql`COALESCE(${transactionImportRecord.rowPosition},excluded."rowPosition")`,
        },
        setWhere: sql`${transactionImportRecord.rowPosition} IS NULL AND excluded."rowPosition" IS NOT NULL`,
      });
  await auditEvidenceRows(tx, actor, "sourceOccurrence", locked, afterOwners);
  const newIds = createdObservations.map((row) => row.id);
  if (newIds.length)
    await auditEvidenceRows(
      tx,
      actor,
      "sourceTransactionRecord",
      [],
      await query
        .select(sourceObservationColumns)
        .from(sourceObservationFrom)
        .where(inArray(sourceTransactionRecord.id, newIds)),
    );
  const rowCountStored = (
    await query
      .select({ id: transactionImportRecord.statementRowId })
      .from(transactionImportRecord)
      .where(eq(transactionImportRecord.importId, batch.id))
  ).length;
  let completed = batch.completedAt !== null;
  if (input.complete && !completed) {
    if (
      !input.import.coverage ||
      input.import.rowCountDeclared === null ||
      input.import.rowCountDeclared !== rowCountStored
    )
      constraintViolation(
        "Completion requires explicit coverage and every declared occurrence, including zero values.",
      );
    await query
      .update(transactionImport)
      .set({ completedAt: new Date() })
      .where(eq(transactionImport.id, batch.id));
    completed = true;
  }
  const withdrawals = planWithdrawals(
    input,
    loaded,
    plan,
    completed,
    rowCountStored,
  );
  let withdrawn = 0;
  for (const owner of withdrawals) {
    const updated = await query
      .update(sourceOccurrence)
      .set({
        withdrawnAt: observedAt,
        withdrawalImportId: batch.id,
        lastObservedAt: observedAt,
        version: sql`${sourceOccurrence.version} + 1`,
      })
      .where(eq(sourceOccurrence.id, owner.id))
      .returning();
    await auditEvidenceRows(tx, actor, "sourceOccurrence", [owner], updated);
    withdrawn++;
  }
  if (novel.length || afterOwners.length || withdrawn)
    await recordChange(tx, { kind: "source", categories: [] });
  const [afterBatch] = await query
    .select()
    .from(transactionImport)
    .where(eq(transactionImport.id, batch.id));
  const received = memberships
    .filter(
      (member) =>
        !members.some(
          (retained) =>
            retained.membership.statementRowId === member.statementRowId,
        ),
    )
    .map((member) => member.statementRowId);
  if (afterBatch)
    await auditEvidenceRows(
      tx,
      actor,
      "transactionImport",
      existingBatch
        ? [received.length ? { ...existingBatch, records: [] } : existingBatch]
        : [],
      [received.length ? { ...afterBatch, records: received } : afterBatch],
    );
  return {
    ...base,
    batchId: batch.id,
    batchCreated: !existingBatch,
    rowCountStored,
    completed,
    withdrawn,
    occurrenceCodes: [
      ...new Set([
        ...chosen.flatMap((row) => {
          const owner = byKey.get(row.incoming.key);
          return owner ? [owner.shortcode] : [];
        }),
        ...locked
          .filter((owner) =>
            input.confirmedWithdrawals.includes(owner.providerIdentity ?? ""),
          )
          .map((owner) => owner.shortcode),
      ]),
    ],
  };
}
