import type { ActorContext } from "@cubby/schemas/context";
import { sourceOccurrenceIdentityKind } from "@cubby/schemas/source-occurrence-fields";
import type { RecordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { moneyToMinor } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { unwrapDb, databaseForTransaction } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  sourceOccurrence,
  sourceTransactionRecord,
  transactionImport,
  transactionImportRecord,
  financialEvidenceAlias,
} from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import type {
  Identity,
  ObservationRef,
  OwnerRef,
  PreparedRow,
  SourceIntakeLoaded,
  SourceIntakePlan,
} from "~/server/domains/transaction-import/policy/source-intake-plan";
import { sourceTransactionRecordExternalId } from "~/server/domains/transaction-import/policy/source-transaction-record-identity";
import {
  sourceObservationColumns,
  sourceObservationsForPage,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  assertNotFuture,
  constraintViolation,
} from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { append, evidenceRow } from "~/server/kernel/api";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { auditEvidenceRows } from "./intake-audit";
import { occurrenceEvidence, statementEvidence } from "./statement-evidence";

const consolidatedProof = z.object({ kind: z.literal("consolidated") });

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
  if (source === "monarch" && row.providerTransactionId)
    return {
      kind: "provider",
      scope: "provider:monarch",
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

export async function prepareRows(
  input: RecordSourceTransactionRecordsInput,
): Promise<PreparedRow[]> {
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
  const facts = await append(
    databaseForTransaction(tx),
    rows.map((row) => evidenceRow(occurrenceEvidence, row)),
  );
  return unwrapDb(tx)
    .select()
    .from(sourceOccurrence)
    .where(
      sql`${sourceOccurrence.id} = ANY(${uuidArrayParam(facts.map((fact) => fact.id))})`,
    );
}
async function insertObservations(
  tx: DrizzleTransaction,
  rows: Omit<typeof sourceTransactionRecord.$inferInsert, "shortcode">[],
) {
  if (!rows.length) return [];
  const facts = await append(
    databaseForTransaction(tx),
    rows.map((row) => evidenceRow(statementEvidence, row)),
  );
  return unwrapDb(tx)
    .select()
    .from(sourceTransactionRecord)
    .where(
      sql`${sourceTransactionRecord.id} = ANY(${uuidArrayParam(facts.map((fact) => fact.id))})`,
    );
}

/** Intake changes evidence/head state only. Unknown revision order never changes accepted money. */
export async function lockAndLoadSourceIntake(
  tx: DrizzleTransaction,
  input: RecordSourceTransactionRecordsInput,
  prepared: PreparedRow[],
): Promise<SourceIntakeLoaded> {
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
  if (!existingBatch) assertNotFuture("observedAt", observedAt);
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
  // An unambiguous legacy reference within this source joins re-exports.
  const positioned = prepared.filter(
    (row) => row.identity?.kind === "positioned",
  );
  const incomingAliases = requestedRows(
    positioned.map((row) => ({
      key: row.key,
      reference: row.legacyExternalId,
    })),
    { key: "text", reference: "text" },
    "incoming",
  );
  const aliasMatches = positioned.length
    ? (
        await query.execute<{ key: string; owner: string }>(sql`
    WITH unique_incoming AS (SELECT min(key) AS key, reference FROM ${incomingAliases.from} GROUP BY reference HAVING count(*) = 1),
    candidates AS (
      SELECT i.key, o.id AS owner FROM unique_incoming i
      JOIN "FinancialEvidenceAlias" a ON a.source=${source} AND a.value=i.reference
      JOIN "SourceTransactionRecord" r ON r.id=a."observationId" AND ${notDeleted("r")}
      JOIN "SourceOccurrence" o ON o.id=r."occurrenceId" AND ${notDeleted("o")}
        AND o."withdrawnAt" IS NULL AND o."supersededByOccurrenceId" IS NULL
      WHERE r."batchId" IS DISTINCT FROM ${existingBatch?.id ?? null}::uuid
      GROUP BY i.key, o.id
    )
    SELECT min(key) AS key, min(owner::text) AS owner FROM candidates GROUP BY key HAVING count(*)=1
  `)
      ).rows
    : [];
  const aliasOwnerIds = aliasMatches.map((match) => match.owner);
  const memberOwnerIds = members.map(
    (member) => member.observation.occurrenceId,
  );
  const possibleOwners = await query
    .select()
    .from(sourceOccurrence)
    .where(
      and(
        eq(sourceOccurrence.source, source),
        or(
          aliasOwnerIds.length || memberOwnerIds.length
            ? sql`${sourceOccurrence.id} = ANY(${uuidArrayParam([...aliasOwnerIds, ...memberOwnerIds])})`
            : undefined,
          scopes.length
            ? inArray(sourceOccurrence.identityScope, scopes)
            : undefined,
          providerIds.length
            ? inArray(sourceOccurrence.providerIdentity, providerIds)
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
      aliasOwnerIds.includes(owner.id) ||
      memberOwnerIds.includes(owner.id),
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
  // A retained membership remains authoritative even if later exports make its alias ambiguous.
  for (const incoming of positioned) {
    const member = members.find(
      (item) => item.membership.rowPosition === incoming.identity?.position,
    );
    const owner =
      member &&
      locked.find(
        (candidate) => candidate.id === member.observation.occurrenceId,
      );
    if (owner) byKey.set(incoming.key, owner);
  }
  for (const match of aliasMatches) {
    const owner = locked.find((candidate) => candidate.id === match.owner);
    if (
      !byKey.has(match.key) &&
      owner &&
      !owner.deletedAt &&
      !owner.withdrawnAt &&
      !owner.supersededByOccurrenceId
    )
      byKey.set(match.key, owner);
  }
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
    retained,
  };
}

/** Execute the plan's writes in order; nothing here decides what to write. */
export async function applySourceIntake(
  tx: DrizzleTransaction,
  actor: ActorContext,
  plan: SourceIntakePlan,
) {
  const query = unwrapDb(tx);
  let batchId = plan.receipt.batchId;
  const mintedOwners = new Map<string, typeof sourceOccurrence.$inferSelect>();
  let createdObservations: (typeof sourceTransactionRecord.$inferSelect)[] = [];
  let afterOwners: (typeof sourceOccurrence.$inferSelect)[] = [];
  let memberships: (typeof transactionImportRecord.$inferInsert)[] = [];
  const requireBatch = () =>
    batchId ?? constraintViolation("The collection batch is missing.");
  const owner = (ref: OwnerRef) =>
    "minted" in ref ? mintedOwners.get(ref.minted)! : ref;
  const observationId = (ref: ObservationRef) =>
    "id" in ref
      ? ref.id
      : createdObservations.find(
          (saved) =>
            saved.occurrenceId === owner(ref.minted.owner).id &&
            saved.factFingerprint === ref.minted.factFingerprint,
        )!.id;
  for (const write of plan.writes) {
    switch (write.kind) {
      case "ensure_source":
        await ensureExternalSources(tx, [write.source]);
        break;
      case "insert_batch":
        batchId = (
          await insertWithShortcode(tx, "transactionImport", write.values)
        ).id;
        break;
      case "insert_occurrences": {
        const created = await insertOccurrences(
          tx,
          write.rows.map(({ values, positionedInBatch }) => ({
            ...values,
            physicalImportId: positionedInBatch ? requireBatch() : null,
          })),
        );
        created.forEach((minted) =>
          mintedOwners.set(identityKey(storedIdentity(minted)), minted),
        );
        break;
      }
      case "insert_observations": {
        createdObservations = await insertObservations(
          tx,
          write.rows.map(({ owner: ref, values }) => ({
            ...values,
            batchId: requireBatch(),
            occurrenceId: owner(ref).id,
          })),
        );
        if (createdObservations.length)
          await query.insert(financialEvidenceAlias).values(
            createdObservations.flatMap((observation) => {
              const planned = write.rows.find(
                (row) =>
                  owner(row.owner).id === observation.occurrenceId &&
                  row.factFingerprint === observation.factFingerprint,
              )!;
              return [
                { kind: "externalId", value: planned.aliases.externalId },
                {
                  kind: "legacyExternalId",
                  value: planned.aliases.legacyExternalId,
                },
              ].map((alias) => ({
                ...alias,
                source: planned.values.source,
                observationId: observation.id,
                occurrenceId: observation.occurrenceId,
                provenanceKey: `observation:${observation.id}:${alias.kind}`,
                provenance: { kind: "source_observation" },
                scopeEvidence: planned.aliases.scopeEvidence,
              }));
            }),
          );
        break;
      }
      case "update_heads": {
        const requestedChanges = requestedRows(
          write.changes.map((change) => ({
            id: owner(change.owner).id,
            head: change.head ? observationId(change.head) : null,
            state: change.reviewState,
            observed: change.lastObservedAt.toISOString(),
            version: change.version,
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
        afterOwners = await query
          .update(sourceOccurrence)
          .set({
            currentObservationId: sql`change.head`,
            reviewState: sql`change.state`,
            lastObservedAt: sql`change.observed::timestamp`,
            version: sql`change.version`,
          })
          .from(requestedChanges.from)
          .where(eq(sourceOccurrence.id, sql`change.id`))
          .returning();
        break;
      }
      case "upsert_memberships": {
        memberships = write.rows.map((row) => ({
          importId: requireBatch(),
          statementRowId: observationId(row.observation),
          rowPosition: row.rowPosition,
          requestFingerprint: row.requestFingerprint,
        }));
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
        break;
      }
      case "audit_occurrences":
        await auditEvidenceRows(
          tx,
          actor,
          "sourceOccurrence",
          write.before,
          afterOwners,
        );
        break;
      case "audit_new_observations": {
        const newIds = createdObservations.map((row) => row.id);
        if (newIds.length)
          await auditEvidenceRows(
            tx,
            actor,
            "sourceTransactionRecord",
            [],
            await query
              .select(sourceObservationColumns)
              .from(
                sql`${sourceObservationsForPage(newIds)} "SourceTransactionRecord"`,
              ),
          );
        break;
      }
      case "complete_batch":
        await query
          .update(transactionImport)
          .set({ completedAt: new Date() })
          .where(eq(transactionImport.id, requireBatch()));
        break;
      case "withdraw_occurrence": {
        const updated = await query
          .update(sourceOccurrence)
          .set({
            withdrawnAt: write.at,
            withdrawalImportId: requireBatch(),
            lastObservedAt: write.at,
            version: sql`${sourceOccurrence.version} + 1`,
          })
          .where(eq(sourceOccurrence.id, write.owner.id))
          .returning();
        await auditEvidenceRows(
          tx,
          actor,
          "sourceOccurrence",
          [write.owner],
          updated,
        );
        break;
      }
      case "record_change":
        await recordChange(tx, { kind: "source", categories: [] });
        break;
      case "audit_batch": {
        const [afterBatch] = await query
          .select()
          .from(transactionImport)
          .where(eq(transactionImport.id, requireBatch()));
        const received = memberships
          .filter(
            (member) => !write.priorMemberIds.includes(member.statementRowId),
          )
          .map((member) => member.statementRowId);
        if (afterBatch)
          await auditEvidenceRows(
            tx,
            actor,
            "transactionImport",
            write.before
              ? [
                  received.length
                    ? { ...write.before, records: [] }
                    : write.before,
                ]
              : [],
            [
              received.length
                ? { ...afterBatch, records: received }
                : afterBatch,
            ],
          );
        break;
      }
      case "refuse":
        return constraintViolation(write.message);
      default: {
        const unreachable: never = write;
        throw new Error(
          `Unplanned intake write ${JSON.stringify(unreachable)}`,
        );
      }
    }
  }
  const { outcome } = plan;
  return {
    ...plan.receipt,
    batchId: requireBatch(),
    batchCreated: outcome.batchCreated,
    rowCountStored: outcome.rowCountStored,
    completed: outcome.completed,
    withdrawn: outcome.withdrawn,
    occurrenceCodes: [
      ...new Set([
        ...outcome.chosenOwners.map((ref) => owner(ref).shortcode),
        ...outcome.withdrawalCodes,
      ]),
    ],
  };
}
