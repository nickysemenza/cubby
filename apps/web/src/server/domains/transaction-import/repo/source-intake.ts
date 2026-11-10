import type { ActorContext } from "@cubby/schemas/context";
import { sourceOccurrenceIdentityKind } from "@cubby/schemas/source-occurrence-fields";
import type { RecordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { generateShortcode, moneyToMinor } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, withSnapshotWrite } from "~/server/db/helpers";
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
async function adoptionPlan(
  query: ReturnType<typeof unwrapDb>,
  source: string,
  prepared: ReadonlyArray<{
    key: string;
    identity: Identity | null;
    row: RecordSourceTransactionRecordsInput["rows"][number];
  }>,
  byKey: ReadonlyMap<string, typeof sourceOccurrence.$inferSelect>,
  locked: ReadonlyArray<typeof sourceOccurrence.$inferSelect>,
  observedAt: Date,
) {
  const adopted = new Map<string, typeof sourceOccurrence.$inferSelect>();
  const incoming = prepared.filter(
    (row) =>
      row.identity?.kind === "provider" &&
      row.identity.providerId &&
      !byKey.has(row.key),
  );
  if (!incoming.length) return adopted;
  const antecedents = await query
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
    );
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
  const targets = new Map<string, number>();
  const plans = incoming.flatMap((row) => {
    const identity = row.identity!;
    const prior = antecedents.filter(
      (record) => record.providerTransactionId === identity.providerId,
    );
    const ownerIds = new Set(prior.map((record) => record.occurrenceId));
    const owner = locked.find((candidate) => ownerIds.has(candidate.id));
    if (
      ownerIds.size !== 1 ||
      !owner ||
      owner.source !== source ||
      owner.identityKind !== "unproven" ||
      owner.deletedAt ||
      owner.withdrawnAt ||
      owner.supersededByOccurrenceId ||
      owner.lastObservedAt > observedAt ||
      prior.length !== 1 ||
      ownerSizes.get(owner.id) !== 1 ||
      prior.some((record) => {
        const claims = providerIdentityClaims(
          z.json().parse(record.providerData),
        );
        return (
          record.deletedAt !== null ||
          claims.malformed ||
          claims.providerIds.some((id) => id !== identity.providerId) ||
          claims.accounts.some((id) => id !== row.row.providerAccountId) ||
          String(record.amount) !==
            String(moneyToMinor(-row.row.providerAmount)) ||
          record.providerAccountId !== row.row.providerAccountId
        );
      })
    )
      return [];
    targets.set(owner.id, (targets.get(owner.id) ?? 0) + 1);
    return [{ key: row.key, identity, owner }];
  });
  for (const { key, identity, owner } of plans) {
    if (targets.get(owner.id) !== 1) continue;
    adopted.set(key, {
      ...owner,
      identityKind: "provider",
      identityScope: identity.scope,
      providerIdentity: identity.providerId,
      identityProof: {
        kind: "raw_provider_ids",
        source,
        account: identity.scope.slice("provider-account:".length),
        provider: identity.providerId!,
        originalIdentityProof: owner.identityProof,
      },
      reviewState: "ready",
    });
  }
  return adopted;
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

async function prepareRows(input: RecordSourceTransactionRecordsInput) {
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
export async function recordSourceTransactionRecords(
  db: Database,
  input: RecordSourceTransactionRecordsInput,
  actor: ActorContext,
) {
  const prepared = await prepareRows(input);
  const result = await withSnapshotWrite(
    db,
    // oxlint-disable-next-line complexity -- One serializable intake owns frozen membership, source admission, frontier and withdrawal checks.
    async (tx) => {
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
        possibleOwners.map((owner) => [
          identityKey(storedIdentity(owner)),
          owner,
        ]),
      );
      const relevant = possibleOwners.filter(
        (owner) =>
          prepared.some(
            (row) => row.key === identityKey(storedIdentity(owner)),
          ) ||
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
      const adopted = await adoptionPlan(
        query,
        source,
        prepared,
        byKey,
        locked,
        observedAt,
      );
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
            .orderBy(
              sourceTransactionRecord.createdAt,
              sourceTransactionRecord.id,
            )
        : [];
      const chosen = prepared.map((incoming) => {
        // A parser-supplied ordinal cannot retroactively attest an old collection.
        // Refuse even an ignored twin before a new occurrence could authorize money.
        if (
          (incoming.identity?.kind === "positioned" ||
            incoming.identity?.kind === "provider") &&
          members.some(
            (member) =>
              member.membership.rowPosition === null &&
              (member.observation.factFingerprint ===
                incoming.factFingerprint ||
                member.legacyAlias === incoming.legacyExternalId),
          )
        )
          constraintViolation(
            "A retained collection has unpositioned evidence; replay cannot attest a new physical position. Retain the original observation and its decisions.",
          );
        if (incoming.identity === null) {
          const retainedMembers = members.filter(
            (member) =>
              member.observation.factFingerprint === incoming.factFingerprint &&
              (member.membership.requestFingerprint === null ||
                member.membership.requestFingerprint ===
                  incoming.requestFingerprint),
          );
          if (retainedMembers.length !== 1)
            constraintViolation(
              "New evidence needs attested provider/account IDs or its original physical collection position. A historical replay must identify exactly one retained collection member.",
            );
          const member = retainedMembers[0]!;
          if (member.observation.deletedAt !== null)
            constraintViolation(
              "A tombstoned historical observation cannot be revived by replay.",
            );
          return {
            incoming,
            owner: undefined,
            observation: member.observation,
            member,
          };
        }
        const owner = byKey.get(incoming.key);
        if (owner?.deletedAt)
          constraintViolation(
            "A tombstoned source identity remains reserved and cannot be silently revived.",
          );
        const positionMember =
          incoming.row.rowPosition === undefined
            ? undefined
            : members.find(
                (member) =>
                  member.membership.rowPosition === incoming.row.rowPosition,
              );
        const providerMember = owner
          ? members.find(
              (member) => member.observation.occurrenceId === owner.id,
            )
          : undefined;
        const member = positionMember ?? providerMember;
        if (
          member &&
          (member.observation.factFingerprint !== incoming.factFingerprint ||
            (member.membership.requestFingerprint !== null &&
              member.membership.requestFingerprint !==
                incoming.requestFingerprint) ||
            member.observation.occurrenceId !== (owner?.id ?? null) ||
            !owner ||
            (member.membership.rowPosition !== null &&
              incoming.row.rowPosition !== undefined &&
              member.membership.rowPosition !== incoming.row.rowPosition))
        )
          constraintViolation(
            "A retained collection position or provider identity cannot change its original observation facts.",
          );
        if (member?.observation.deletedAt)
          constraintViolation(
            "A retained collection observation is tombstoned; replay cannot replace it.",
          );
        if (member)
          return { incoming, owner, observation: member.observation, member };
        if (owner?.supersededByOccurrenceId)
          constraintViolation(
            "New collection evidence cannot revive a replaced source occurrence.",
          );
        const current = owner
          ? retained.find(
              (saved) =>
                saved.id === owner.currentObservationId &&
                saved.factFingerprint === incoming.factFingerprint &&
                saved.deletedAt === null,
            )
          : undefined;
        const observation =
          current ??
          (owner
            ? retained.find(
                (saved) =>
                  saved.occurrenceId === owner.id &&
                  saved.factFingerprint === incoming.factFingerprint &&
                  saved.deletedAt === null,
              )
            : undefined);
        if (
          owner?.identityKind === "positioned" &&
          retained.some(
            (saved) =>
              saved.occurrenceId === owner.id &&
              saved.factFingerprint !== incoming.factFingerprint,
          )
        )
          constraintViolation(
            "A positioned occurrence cannot change the frozen facts of its original collection row.",
          );
        return { incoming, owner, observation, member: undefined };
      });
      if (existingBatch?.completedAt && chosen.some((row) => !row.member))
        constraintViolation(
          "A completed collection cannot admit additional observations.",
        );
      const novel = chosen.filter((row) => !row.observation);
      const revised = chosen.filter(
        (row) =>
          row.owner &&
          row.owner.currentObservationId &&
          row.observation?.id !== row.owner.currentObservationId,
      );
      const refreshed = chosen.filter(
        (row) =>
          row.owner &&
          row.observation?.id === row.owner.currentObservationId &&
          row.owner.lastObservedAt < observedAt,
      );
      const occurrenceCodes: string[] = [];
      const base = {
        batchId: existingBatch?.id ?? null,
        batchCreated: false,
        dryRun: input.dryRun,
        inserted: novel.length,
        unchanged: chosen.length - novel.length,
        alreadyInThisBatch: chosen.filter((row) => row.member).length,
        alreadyInAnotherBatch: chosen.filter(
          (row) => row.observation && !row.member,
        ).length,
        rowCountStored: members.length,
        completed:
          existingBatch?.completedAt !== null && existingBatch !== undefined,
        revised: revised.length,
        refreshed: refreshed.length,
        withdrawn: 0,
        correctionReviews: [],
        occurrenceCodes,
        signWarning: statementSignWarning(input.rows),
      };
      if (input.dryRun) return base;
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
      const overlapKeys = new Set(
        fresh.length
          ? (
              await query.execute<{ key: string }>(sql`
        -- includes-deleted: unknown historical scope and cross-collection overlap only block automatic authority.
        WITH incoming(key,reference,provider,owner,kind) AS (VALUES ${sql.join(
          fresh.map(
            ({ incoming }) =>
              sql`(${incoming.key},${incoming.legacyExternalId},${incoming.row.providerTransactionId ?? null}::text,${byKey.get(incoming.key)!.id}::uuid,${requiredIdentity(incoming.identity).kind}::text)`,
          ),
          sql`, `,
        )})
        SELECT DISTINCT incoming.key FROM incoming
        JOIN "FinancialEvidenceAlias" alias ON alias.source=${source} AND alias.value=incoming.reference
        LEFT JOIN "SourceTransactionRecord" antecedent ON antecedent.id=alias."observationId"
        WHERE incoming.kind=${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.positioned)} AND (antecedent."batchId"<>${batch.id}::uuid OR (antecedent.id IS NULL AND alias."historicalTransactionId" IS NOT NULL))
        UNION
        SELECT DISTINCT incoming.key FROM incoming
        JOIN "SourceTransactionRecord" antecedent ON antecedent.source=${source} AND antecedent."providerTransactionId"=incoming.provider
        LEFT JOIN "SourceOccurrence" prior ON prior.id=antecedent."occurrenceId"
        WHERE incoming.provider IS NOT NULL AND antecedent."batchId"<>${batch.id}::uuid AND antecedent."occurrenceId" IS DISTINCT FROM incoming.owner
          AND (prior.id IS NULL OR prior."identityKind"<>${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.provider)})`)
            ).rows.map((row) => row.key)
          : [],
      );
      const headChanges = chosen.flatMap((row) => {
        const owner = byKey.get(row.incoming.key);
        if (!owner || row.member) return [];
        const observation =
          row.observation ??
          createdObservations.find(
            (saved) =>
              saved.occurrenceId === owner.id &&
              saved.factFingerprint === row.incoming.factFingerprint,
          )!;
        const differentFacts =
          owner.currentObservationId !== null &&
          owner.currentObservationId !== observation.id &&
          retained.find((saved) => saved.id === owner.currentObservationId)
            ?.factFingerprint !== row.incoming.factFingerprint;
        const adoption = adopted.has(row.incoming.key);
        // Adoption proves identity, not revision order: differing facts wait
        // for the same head review as any provider owner.
        const currentObservationId = adoption
          ? differentFacts
            ? null
            : observation.id
          : !row.owner
            ? observation.id
            : differentFacts &&
                owner.withdrawnAt === null &&
                owner.reviewState === "ready"
              ? null
              : owner.currentObservationId;
        const failedProviderProof =
          !!row.incoming.row.providerTransactionId &&
          row.incoming.identity?.kind !== "provider";
        const reviewState = adoption
          ? differentFacts
            ? "revision_order_unknown"
            : owner.reviewState
          : owner.reviewState !== "ready" &&
              owner.reviewState !== "revision_order_unknown"
            ? owner.reviewState
            : overlapKeys.has(row.incoming.key) || failedProviderProof
              ? "identity_conflict"
              : owner.withdrawnAt !== null && observedAt > owner.withdrawnAt
                ? "reappeared"
                : differentFacts && owner.reviewState === "ready"
                  ? "revision_order_unknown"
                  : owner.reviewState;
        const semantic =
          adoption ||
          (row.owner !== undefined &&
            (currentObservationId !== owner.currentObservationId ||
              reviewState !== owner.reviewState));
        const lastObservedAt =
          owner.lastObservedAt < observedAt ? observedAt : owner.lastObservedAt;
        if (
          row.owner &&
          !semantic &&
          lastObservedAt.getTime() === owner.lastObservedAt.getTime()
        )
          return [];
        return [
          {
            id: owner.id,
            currentObservationId,
            reviewState,
            lastObservedAt,
            version: owner.version + (semantic ? 1 : 0),
          },
        ];
      });
      const afterOwners = headChanges.length
        ? await query
            .update(sourceOccurrence)
            .set({
              currentObservationId: sql`change.head`,
              reviewState: sql`change.state`,
              lastObservedAt: sql`change.observed`,
              version: sql`change.version`,
            })
            .from(
              sql`(VALUES ${sql.join(
                headChanges.map(
                  (row) =>
                    sql`(${row.id}::uuid,${row.currentObservationId}::uuid,${row.reviewState}::text,${row.lastObservedAt.toISOString()}::timestamp,${row.version}::integer)`,
                ),
                sql`, `,
              )}) change(id,head,state,observed,version)`,
            )
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
      await auditEvidenceRows(
        tx,
        actor,
        "sourceOccurrence",
        locked,
        afterOwners,
      );
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
      let withdrawn = 0;
      if (input.confirmedWithdrawals.length) {
        const coverage = input.import.coverage;
        if (
          !completed ||
          !coverage ||
          coverage.visibility !== "all" ||
          input.import.rowCountDeclared !== rowCountStored
        )
          return constraintViolation(
            "Withdrawals require a completed, exhaustive rechecked account window.",
          );
        const withdrawals = locked.filter(
          (owner) =>
            owner.source === source &&
            owner.identityKind === "provider" &&
            owner.identityScope === `provider-account:${coverage.account}` &&
            input.confirmedWithdrawals.includes(owner.providerIdentity!),
        );
        if (withdrawals.length !== input.confirmedWithdrawals.length)
          constraintViolation(
            "Every confirmed withdrawal must identify a retained occurrence in the proven account scope.",
          );
        for (const owner of withdrawals) {
          const head = retained.find(
            (row) => row.id === owner.currentObservationId,
          );
          if (
            !head ||
            head.statementDate < coverage.from ||
            head.statementDate > coverage.to ||
            owner.lastObservedAt > observedAt ||
            chosen.some((row) => row.owner?.id === owner.id)
          )
            constraintViolation(
              "The confirmed removal is observed, newer, unresolved, or outside the collection scope.",
            );
          if (owner.withdrawnAt !== null) continue;
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
          await auditEvidenceRows(
            tx,
            actor,
            "sourceOccurrence",
            [owner],
            updated,
          );
          withdrawn++;
        }
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
            ? [
                received.length
                  ? { ...existingBatch, records: [] }
                  : existingBatch,
              ]
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
                input.confirmedWithdrawals.includes(
                  owner.providerIdentity ?? "",
                ),
              )
              .map((owner) => owner.shortcode),
          ]),
        ],
      };
    },
    { isolationLevel: "serializable" },
  );
  const { occurrenceCodes, ...receipt } = result;
  // Correction reaches financial booking and kernel handlers; defer that graph until intake has initialized.
  const { reconcileRecordedFinancialEvidence } =
    await import("./statement-evidence-correction");
  return {
    ...receipt,
    correctionReviews: input.dryRun
      ? []
      : await reconcileRecordedFinancialEvidence(
          db,
          input.import.source,
          occurrenceCodes,
          actor,
        ),
  };
}

function statementSignWarning(
  rows: ReadonlyArray<{ providerAmount: number }>,
): string | null {
  const positive = rows.filter((row) => row.providerAmount > 0).length;
  return rows.length >= 20 && positive / rows.length > 0.9
    ? `${positive} of ${rows.length} rows have a positive providerAmount. Charges must be submitted negative; check the export sign convention. Legitimate if this collection is income or refunds.`
    : null;
}
