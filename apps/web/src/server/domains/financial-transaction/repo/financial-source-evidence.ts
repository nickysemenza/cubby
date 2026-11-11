import { randomUUID } from "node:crypto";

import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import {
  parseEntityId,
  shortcodeSchema,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";

import { sourceOccurrenceHasUnresolvedHistory } from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requestedRows } from "~/server/db/helpers/requested";
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
} from "~/server/db/retained-tables";
import {
  financialEvidenceAmountMinor,
  lockFinancialEvidenceKeys,
} from "~/server/domains/financial-transaction/repo/financial-evidence";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { createAppError } from "~/server/errors/app-error";
import { findPgError } from "~/server/errors/db-errors";
import { recordChange } from "~/server/generic/changes/repo/change";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";

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
  await assertFinancialSourceRefsAvailableFor(db, [
    { refs, exceptTransactionId },
  ]);
}

/**
 * Set-based availability check. Every fact is read up front; the checks then
 * run in entry and ref order, so the first refusal matches a per-ref check.
 */
export async function assertFinancialSourceRefsAvailableFor(
  db: RepositoryQueryInput,
  entries: readonly {
    refs: readonly SourceRef[];
    exceptTransactionId?: string;
  }[],
): Promise<void> {
  const query = repositoryQueries(db);
  const exceptIds = uniq(
    entries.flatMap((entry) =>
      entry.exceptTransactionId ? [entry.exceptTransactionId] : [],
    ),
  );
  const retainedById = exceptIds.length
    ? await financialSourceRefsFor(db, exceptIds)
    : new Map<string, SourceRef[]>();
  const retainedKeys = (exceptTransactionId: string | undefined) =>
    new Set(
      (exceptTransactionId
        ? (retainedById.get(exceptTransactionId) ?? [])
        : []
      ).map(refKey),
    );
  const codes = uniq(
    entries.flatMap((entry) =>
      entry.refs.flatMap((ref) => {
        const code = occurrenceCode(ref);
        return code.success ? [code.data] : [];
      }),
    ),
  );
  const owners = new Map(
    (codes.length
      ? await query
          .select()
          .from(sourceOccurrence)
          .where(inArray(sourceOccurrence.shortcode, codes))
      : []
    ).map((owner) => [owner.shortcode, owner]),
  );
  // The history predicate aliases its own occurrence join as `owner`.
  const checked = requestedRows(
    [...owners.values()].map((owner) => ({
      id: owner.id,
      accepted: owner.acceptedTransactionId,
    })),
    { id: "uuid", accepted: "uuid" },
    "checked",
  );
  const history = new Map(
    owners.size
      ? (
          await query.execute<{ id: string; held: boolean }>(
            sql`SELECT ${checked.col("id")}::text AS id, ${sourceOccurrenceHasUnresolvedHistory(checked.col("id"), checked.col("accepted"))} AS held
            FROM ${checked.from}`,
          )
        ).rows.map((row) => [row.id, row.held])
      : [],
  );
  const aliasRefs = uniqBy(
    entries.flatMap((entry) => {
      const have = retainedKeys(entry.exceptTransactionId);
      return entry.refs.filter(
        (ref) => !occurrenceCode(ref).success && !have.has(refKey(ref)),
      );
    }),
    refKey,
  );
  const wantedAliases = requestedRows(
    aliasRefs.map((ref) => ({ source: ref.source, value: ref.externalId })),
    { source: "text", value: "text" },
    "wanted",
  );
  const aliased = new Set(
    (aliasRefs.length
      ? await query
          .selectDistinct({
            source: financialEvidenceAlias.source,
            externalId: financialEvidenceAlias.value,
          })
          .from(financialEvidenceAlias)
          .where(
            and(
              sql`(${financialEvidenceAlias.source}, ${financialEvidenceAlias.value}) IN (SELECT ${wantedAliases.col("source")}, ${wantedAliases.col("value")} FROM ${wantedAliases.from})`,
              or(
                isNotNull(financialEvidenceAlias.observationId),
                sql`(${financialEvidenceAlias.deletedAt} IS NULL AND EXISTS(SELECT 1 FROM "FinancialTransaction" bound WHERE bound.id=${financialEvidenceAlias.historicalTransactionId} AND ${notDeleted("bound")}))`,
              ),
            ),
          )
      : []
    ).map(refKey),
  );
  for (const { refs, exceptTransactionId } of entries) {
    const have = retainedKeys(exceptTransactionId);
    for (const ref of refs) {
      const code = occurrenceCode(ref);
      if (code.success) {
        const owner = owners.get(code.data);
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
        if (history.get(owner.id))
          refuse(
            "Unresolved historical bindings require an explicit ownership review before accepting this source occurrence.",
          );
        continue;
      }
      if (have.has(refKey(ref))) continue;
      // Retired and ambiguous bindings block fresh actions too; alias uniqueness never proves ownership.
      if (aliased.has(refKey(ref)) || /^v[123]:/.test(ref.externalId))
        refuse(
          "Retained source evidence requires an explicit identity and ownership review before it can authorize a new transaction.",
        );
    }
  }
}

type AcceptedSourceChanges = {
  before: (typeof sourceOccurrence.$inferSelect)[];
  after: (typeof sourceOccurrence.$inferSelect)[];
};

/** The caller holds every affected occurrence and target lock. Aliases are provenance only. */
export async function replaceFinancialSourceRefs(
  tx: RepositoryQueryTransaction,
  transactionId: string,
  refs: readonly SourceRef[],
): Promise<AcceptedSourceChanges> {
  return replaceFinancialSourceRefsFor(tx, [{ transactionId, refs }]);
}

/**
 * Set-based {@link replaceFinancialSourceRefs}: one owner read, one release
 * and one acceptance statement across every transaction. An occurrence named
 * by two transactions refuses before any write.
 */
export async function replaceFinancialSourceRefsFor(
  tx: RepositoryQueryTransaction,
  entries: readonly { transactionId: string; refs: readonly SourceRef[] }[],
): Promise<AcceptedSourceChanges> {
  if (!entries.length) return { before: [], after: [] };
  const query = repositoryQueries(tx);
  const ids = entries.map((entry) =>
    parseEntityId("financialTransaction", entry.transactionId),
  );
  if (new Set(ids).size !== ids.length)
    throw new Error("One source ref replacement names a transaction twice");
  const transactions = new Map(
    (
      await query
        .select()
        .from(financialTransaction)
        .where(
          and(
            inArray(financialTransaction.id, ids),
            notDeleted(financialTransaction),
          ),
        )
    )
      .map(transactionDollars)
      .map((row) => [row.id, row]),
  );
  if (ids.some((id) => !transactions.has(id)))
    return refuse("The accepted transaction is no longer live.");
  const currentById = await financialSourceRefsFor(tx, ids);
  const codesByEntry = entries.map(
    (entry) =>
      new Set<string>(
        entry.refs.flatMap((ref) => {
          const code = occurrenceCode(ref);
          return code.success ? [code.data] : [];
        }),
      ),
  );
  const ownerOf = new Map<string, (typeof ids)[number]>();
  for (const [index, codes] of codesByEntry.entries())
    for (const code of codes) {
      if (ownerOf.has(code))
        refuse(
          "The proven occurrence is unavailable or has a different accepted owner. Refresh its source review.",
        );
      ownerOf.set(code, ids[index]!);
    }
  const owners = ownerOf.size
    ? await query
        .select()
        .from(sourceOccurrence)
        .where(inArray(sourceOccurrence.shortcode, [...ownerOf.keys()]))
    : [];
  const addedOwners = owners.filter(
    (owner) => owner.acceptedTransactionId !== ownerOf.get(owner.shortcode),
  );
  const headIds = uniq(
    addedOwners.flatMap((owner) =>
      owner.currentObservationId ? [owner.currentObservationId] : [],
    ),
  );
  const heads = new Map(
    (headIds.length
      ? await query
          .select()
          .from(sourceTransactionRecord)
          .where(
            and(
              inArray(sourceTransactionRecord.id, headIds),
              notDeleted(sourceTransactionRecord),
            ),
          )
      : []
    ).map((head) => [head.id, head]),
  );
  for (const owner of addedOwners) {
    const transaction = transactions.get(ownerOf.get(owner.shortcode)!)!;
    const head = owner.currentObservationId
      ? heads.get(owner.currentObservationId)
      : undefined;
    if (
      !head ||
      owner.accountId !== transaction.accountId ||
      head.amount !== financialEvidenceAmountMinor(transaction.amount)
    )
      refuse(
        "The current source amount or resolved account differs from the accepted transaction. Review the current facts.",
      );
  }
  await assertFinancialSourceRefsAvailableFor(
    tx,
    entries.map((entry) => ({
      refs: entry.refs,
      exceptTransactionId: entry.transactionId,
    })),
  );
  const previousOwners = await query
    .select()
    .from(sourceOccurrence)
    .where(inArray(sourceOccurrence.acceptedTransactionId, ids));
  const removedOwners = previousOwners.filter(
    (owner) =>
      !codesByEntry[ids.indexOf(owner.acceptedTransactionId!)]!.has(
        owner.shortcode,
      ),
  );
  const releasing = requestedRows(
    removedOwners.map((owner) => ({
      id: owner.id,
      accepted: owner.acceptedTransactionId,
    })),
    { id: "uuid", accepted: "uuid" },
    "releasing",
  );
  const released = removedOwners.length
    ? await query
        .update(sourceOccurrence)
        .set({
          acceptedTransactionId: null,
          version: sql`${sourceOccurrence.version}+1`,
        })
        .where(
          sql`(${sourceOccurrence.id}, ${sourceOccurrence.acceptedTransactionId}) IN (SELECT ${releasing.col("id")}, ${releasing.col("accepted")} FROM ${releasing.from})`,
        )
        .returning()
    : [];
  const admitted = addedOwners.length
    ? await query
        .update(sourceOccurrence)
        .set({
          acceptedTransactionId: sql`CASE ${sourceOccurrence.id} ${sql.join(
            addedOwners.map(
              (owner) =>
                sql`WHEN ${owner.id}::uuid THEN ${ownerOf.get(owner.shortcode)!}::uuid`,
            ),
            sql` `,
          )} END`,
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
  const added: { ref: SourceRef; id: (typeof ids)[number] }[] = [];
  let refsDropped = false;
  for (const [index, entry] of entries.entries()) {
    const id = ids[index]!;
    const current = currentById.get(id) ?? [];
    const wanted = new Set(entry.refs.map(refKey));
    const have = new Set(current.map(refKey));
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
    for (const ref of entry.refs)
      if (!have.has(refKey(ref)) && !occurrenceCode(ref).success)
        added.push({ ref, id });
    if (current.some((ref) => !wanted.has(refKey(ref)))) refsDropped = true;
  }
  if (added.length) {
    await ensureExternalSources(
      tx,
      added.map(({ ref }) => ref.source),
    );
    try {
      await query.insert(financialEvidenceAlias).values(
        added.map(({ ref, id }) => ({
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
  if (added.length || removedOwners.length || addedOwners.length || refsDropped)
    await recordChange(tx, {
      kind: "source",
      categories: ["financialTransaction"],
    });
  return {
    before: [...removedOwners, ...addedOwners],
    after: [...released, ...admitted],
  };
}
