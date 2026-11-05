import { randomUUID } from "node:crypto";

import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import {
  parseEntityId,
  shortcodeSchema,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { sourceOccurrenceHasUnresolvedHistory } from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries,
  type RepositoryQueryInput,
  type RepositoryQueryTransaction,
} from "~/server/db/repository-access.boundary";
import {
  sourceOccurrence,
  sourceTransactionRecord,
  financialEvidenceAlias,
  financialTransaction,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { findPgError } from "~/server/errors/db-errors";
import { recordChange } from "~/server/generic/changes/repo/change";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";

import {
  financialEvidenceAmountMinor,
  lockFinancialEvidenceKeys,
} from "./financial-evidence";

type SourceRef = FinancialTransactionSourceRef;
const refKey = (ref: SourceRef) => JSON.stringify([ref.source, ref.externalId]);
const occurrenceCode = (ref: SourceRef) =>
  shortcodeSchema("sourceOccurrence").safeParse(ref.externalId);
const refuse = (message: string): never => {
  throw createAppError("FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT", message);
};

/** Presentation of retained references on an already identified transaction. Never resolve acceptance from these rows. */
export const financialSourceReferenceRows = sql`(
  -- includes-deleted: occurrence reservations and accepted history survive source tombstones.
  SELECT occurrence."acceptedTransactionId" AS owner,occurrence.source,occurrence.shortcode AS "externalId" FROM "SourceOccurrence" occurrence WHERE occurrence."acceptedTransactionId" IS NOT NULL
  UNION
  SELECT alias."historicalTransactionId",alias.source,alias.value FROM "FinancialEvidenceAlias" alias
  WHERE alias."historicalTransactionId" IS NOT NULL AND ${notDeleted("alias")}
)`;

/** Existing sourceRefs remain readable provenance. Only an SOC handle addresses an accepted owner. */
export async function financialSourceRefsFor(
  db: RepositoryQueryInput,
  transactionIds: readonly string[],
): Promise<Map<string, SourceRef[]>> {
  const out = new Map<string, SourceRef[]>();
  if (!transactionIds.length) return out;
  const ids = transactionIds.map((id) =>
    parseEntityId("financialTransaction", id),
  );
  const occurrences = await repositoryQueries(db)
    .select({
      transactionId: sourceOccurrence.acceptedTransactionId,
      source: sourceOccurrence.source,
      externalId: sourceOccurrence.shortcode,
    })
    .from(sourceOccurrence)
    .where(inArray(sourceOccurrence.acceptedTransactionId, ids));
  const aliases = await repositoryQueries(db)
    .select({
      transactionId: financialEvidenceAlias.historicalTransactionId,
      source: financialEvidenceAlias.source,
      externalId: financialEvidenceAlias.value,
    })
    .from(financialEvidenceAlias)
    .where(
      and(
        inArray(financialEvidenceAlias.historicalTransactionId, ids),
        notDeleted(financialEvidenceAlias),
      ),
    );
  for (const row of [...occurrences, ...aliases]) {
    if (row.transactionId === null) continue;
    const values = out.get(row.transactionId) ?? [];
    if (!values.some((value) => refKey(value) === refKey(row)))
      values.push({ source: row.source, externalId: row.externalId });
    out.set(row.transactionId, values);
  }
  for (const values of out.values())
    values.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.externalId.localeCompare(right.externalId),
    );
  return out;
}

export async function financialSourceRefsIncluding(
  db: RepositoryQueryInput,
  transactionId: string,
  ref: SourceRef,
): Promise<SourceRef[]> {
  const values =
    (await financialSourceRefsFor(db, [transactionId])).get(transactionId) ??
    [];
  if (!values.some((value) => refKey(value) === refKey(ref))) values.push(ref);
  return values.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.externalId.localeCompare(right.externalId),
  );
}

/** Reserve existing transaction commands, then every occurrence, before settlement row locks. */
export async function lockFinancialTransactionSources(
  tx: RepositoryQueryTransaction,
  codes: readonly FinancialTransactionShortcode[],
  refs: readonly SourceRef[] = [],
): Promise<void> {
  const query = repositoryQueries(tx);
  const targets = codes.length
    ? await query
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(inArray(financialTransaction.shortcode, [...codes]))
    : [];
  await lockFinancialEvidenceKeys(
    tx,
    "reviewed-booking",
    targets.map((target) => `transaction:${target.id}`),
  );
  const retainedRefs = await financialSourceRefsFor(
    tx,
    targets.map((target) => target.id),
  );
  await lockFinancialEvidenceKeys(
    tx,
    "transaction-ref",
    [...refs, ...[...retainedRefs.values()].flat()]
      .filter((ref) => !occurrenceCode(ref).success)
      .map(refKey),
  );
  const occurrences = refs.flatMap((ref) => {
    const code = occurrenceCode(ref);
    return code.success ? [code.data] : [];
  });
  const where = or(
    targets.length
      ? inArray(
          sourceOccurrence.acceptedTransactionId,
          targets.map((target) => target.id),
        )
      : undefined,
    occurrences.length
      ? inArray(sourceOccurrence.shortcode, occurrences)
      : undefined,
  );
  if (where)
    await query
      .select({ id: sourceOccurrence.id })
      .from(sourceOccurrence)
      .where(where)
      .orderBy(asc(sourceOccurrence.id))
      .for("update");
}

/** Call before party, Purchase and FinancialTransaction row locks, including ordinary money edits. */
export async function lockFinancialSourceOccurrences(
  tx: RepositoryQueryTransaction,
  refs: readonly SourceRef[],
  transactionId?: string,
) {
  const retainedRefs = transactionId
    ? ((await financialSourceRefsFor(tx, [transactionId])).get(transactionId) ??
      [])
    : [];
  await lockFinancialEvidenceKeys(
    tx,
    "transaction-ref",
    [...refs, ...retainedRefs]
      .filter((ref) => !occurrenceCode(ref).success)
      .map(refKey),
  );
  const codes = refs.flatMap((ref) => {
    const code = occurrenceCode(ref);
    return code.success ? [code.data] : [];
  });
  const where = or(
    codes.length ? inArray(sourceOccurrence.shortcode, codes) : undefined,
    transactionId
      ? eq(
          sourceOccurrence.acceptedTransactionId,
          parseEntityId("financialTransaction", transactionId),
        )
      : undefined,
  );
  if (!where) return [];
  return repositoryQueries(tx)
    .select()
    .from(sourceOccurrence)
    .where(where)
    .orderBy(asc(sourceOccurrence.id))
    .for("update");
}

export async function assertFinancialSourceRefsAvailable(
  db: RepositoryQueryInput,
  refs: readonly SourceRef[],
  exceptTransactionId?: string,
): Promise<void> {
  const query = repositoryQueries(db);
  const retained = exceptTransactionId
    ? ((await financialSourceRefsFor(db, [exceptTransactionId])).get(
        exceptTransactionId,
      ) ?? [])
    : [];
  const have = new Set(retained.map(refKey));
  for (const ref of refs) {
    const code = occurrenceCode(ref);
    if (code.success) {
      const [owner] = await query
        .select()
        .from(sourceOccurrence)
        .where(eq(sourceOccurrence.shortcode, code.data));
      // Retaining an existing reservation is not a fresh acceptance, even after withdrawal or replacement.
      if (
        owner?.source === ref.source &&
        owner.acceptedTransactionId === exceptTransactionId &&
        have.has(refKey(ref))
      )
        continue;
      if (
        !owner ||
        owner.source !== ref.source ||
        owner.deletedAt !== null ||
        owner.reviewState !== "ready" ||
        owner.currentObservationId === null ||
        owner.withdrawnAt !== null ||
        owner.supersededByOccurrenceId !== null ||
        owner.replacementObservationId !== null ||
        (owner.acceptedTransactionId !== null &&
          owner.acceptedTransactionId !== exceptTransactionId)
      ) {
        return refuse(
          "The proven occurrence is unavailable or has a different accepted owner. Refresh its source review.",
        );
      }
      const history = await query.execute<{ held: boolean }>(
        sql`SELECT ${sourceOccurrenceHasUnresolvedHistory(sql`${owner.id}::uuid`, sql`${owner.acceptedTransactionId}::uuid`)} AS held`,
      );
      if (history.rows[0]?.held)
        refuse(
          "Unresolved historical bindings require an explicit ownership review before accepting this source occurrence.",
        );
      continue;
    }
    if (have.has(refKey(ref))) continue;
    const [alias] = await query
      .select({ id: financialEvidenceAlias.id })
      .from(financialEvidenceAlias)
      .where(
        and(
          eq(financialEvidenceAlias.source, ref.source),
          eq(financialEvidenceAlias.value, ref.externalId),
          or(
            sql`${financialEvidenceAlias.observationId} IS NOT NULL`,
            sql`(${financialEvidenceAlias.deletedAt} IS NULL AND EXISTS(SELECT 1 FROM "FinancialTransaction" bound WHERE bound.id=${financialEvidenceAlias.historicalTransactionId} AND ${notDeleted("bound")}))`,
          ),
        ),
      )
      .limit(1);
    // Retired and ambiguous bindings block fresh actions too; alias uniqueness never proves ownership.
    if (alias || /^v[123]:/.test(ref.externalId))
      refuse(
        "Retained source evidence requires an explicit identity and ownership review before it can authorize a new transaction.",
      );
  }
}

/** The caller holds every affected occurrence and target lock. Aliases are provenance only. */
export async function replaceFinancialSourceRefs(
  tx: RepositoryQueryTransaction,
  transactionId: string,
  refs: readonly SourceRef[],
): Promise<{
  before: (typeof sourceOccurrence.$inferSelect)[];
  after: (typeof sourceOccurrence.$inferSelect)[];
}> {
  const query = repositoryQueries(tx);
  const id = parseEntityId("financialTransaction", transactionId);
  const [transaction] = await query
    .select()
    .from(financialTransaction)
    .where(
      and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
    );
  if (!transaction)
    return refuse("The accepted transaction is no longer live.");
  const current =
    (await financialSourceRefsFor(tx, [transactionId])).get(transactionId) ??
    [];
  const wanted = new Set(refs.map(refKey));
  const have = new Set(current.map(refKey));
  const codes = refs.flatMap((ref) => {
    const code = occurrenceCode(ref);
    return code.success ? [code.data] : [];
  });
  const owners = codes.length
    ? await query
        .select()
        .from(sourceOccurrence)
        .where(inArray(sourceOccurrence.shortcode, codes))
    : [];
  for (const owner of owners.filter(
    (owner) => owner.acceptedTransactionId !== id,
  )) {
    const [head] = owner.currentObservationId
      ? await query
          .select()
          .from(sourceTransactionRecord)
          .where(
            and(
              eq(sourceTransactionRecord.id, owner.currentObservationId),
              notDeleted(sourceTransactionRecord),
            ),
          )
      : [];
    if (
      !head ||
      owner.accountId !== transaction.accountId ||
      head.amount !== financialEvidenceAmountMinor(transaction.amount)
    )
      refuse(
        "The current source amount or resolved account differs from the accepted transaction. Review the current facts.",
      );
  }
  await assertFinancialSourceRefsAvailable(tx, refs, transactionId);
  const previousOwners = await query
    .select()
    .from(sourceOccurrence)
    .where(eq(sourceOccurrence.acceptedTransactionId, id));
  const removedOwners = previousOwners.filter(
    (owner) => !new Set<string>(codes).has(owner.shortcode),
  );
  const addedOwners = owners.filter(
    (owner) => owner.acceptedTransactionId !== id,
  );
  const released = removedOwners.length
    ? await query
        .update(sourceOccurrence)
        .set({
          acceptedTransactionId: null,
          version: sql`${sourceOccurrence.version}+1`,
        })
        .where(
          and(
            inArray(
              sourceOccurrence.id,
              removedOwners.map((owner) => owner.id),
            ),
            eq(sourceOccurrence.acceptedTransactionId, id),
          ),
        )
        .returning()
    : [];
  const admitted = addedOwners.length
    ? await query
        .update(sourceOccurrence)
        .set({
          acceptedTransactionId: id,
          version: sql`${sourceOccurrence.version}+1`,
        })
        .where(
          and(
            inArray(
              sourceOccurrence.id,
              addedOwners.map((owner) => owner.id),
            ),
            isNull(sourceOccurrence.acceptedTransactionId),
          ),
        )
        .returning()
    : [];
  if (
    released.length !== removedOwners.length ||
    admitted.length !== addedOwners.length
  )
    refuse(
      "Accepted source ownership changed while applying the review; refresh and retry.",
    );
  for (const removed of current.filter(
    (ref) => !wanted.has(refKey(ref)) && !occurrenceCode(ref).success,
  ))
    await query
      .update(financialEvidenceAlias)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(financialEvidenceAlias.historicalTransactionId, id),
          eq(financialEvidenceAlias.source, removed.source),
          eq(financialEvidenceAlias.value, removed.externalId),
          notDeleted(financialEvidenceAlias),
        ),
      );
  const added = refs.filter(
    (ref) => !have.has(refKey(ref)) && !occurrenceCode(ref).success,
  );
  if (added.length) {
    await ensureExternalSources(
      tx,
      added.map((ref) => ref.source),
    );
    try {
      await query.insert(financialEvidenceAlias).values(
        added.map((ref) => ({
          source: ref.source,
          kind: "transaction_ref",
          value: ref.externalId,
          historicalTransactionId: id,
          provenanceKey: `manual:${randomUUID()}`,
          provenance: { kind: "explicit_transaction_reference" },
          scopeEvidence: {},
        })),
      );
    } catch (error) {
      if (
        findPgError(error)?.constraint ===
        "FinancialEvidenceAlias_live_manual_reference_key"
      )
        refuse(
          "Another transaction accepted this explicit reference while the reviewed write was waiting.",
        );
      throw error;
    }
  }
  if (
    added.length ||
    previousOwners.some(
      (owner) => !new Set<string>(codes).has(owner.shortcode),
    ) ||
    owners.some((owner) => owner.acceptedTransactionId !== id) ||
    current.some((ref) => !wanted.has(refKey(ref)))
  )
    await recordChange(tx, {
      kind: "source",
      categories: ["financialTransaction"],
    });
  return {
    before: [...removedOwners, ...addedOwners],
    after: [...released, ...admitted],
  };
}
