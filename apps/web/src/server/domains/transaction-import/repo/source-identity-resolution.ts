import type { ActorContext } from "@cubby/schemas/context";
import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import {
  sourceOccurrenceIdentityKind,
  type SourceIdentityResolution,
} from "@cubby/schemas/source-occurrence-fields";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { sourceHistoricalTransactionRows } from "~/server/db/computed/source-occurrence-history-sql";
import {
  databaseForTransaction,
  notDeleted,
  unwrapDb,
} from "~/server/db/helpers";
import { transactionImportRecord } from "~/server/db/retained-tables";
import {
  financialAccount,
  financialEvidenceAlias,
  financialTransaction,
  sourceOccurrence,
  sourceTransactionRecord,
  suggestionTable,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  financialEvidenceAmountMinor,
  lockFinancialEvidenceKeys,
} from "~/server/domains/financial-transaction/repo/financial-evidence";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { providerIdentityClaims } from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import { constraintViolation } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { transitionSuggestionStates } from "~/server/generic/suggestions/repo/suggestion-state";
import { jsonSnapshot } from "~/server/lib/canonical-json";

import { auditEvidenceRows } from "./intake-audit";

const sameSet = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...new Set(left)].sort()) ===
  JSON.stringify([...new Set(right)].sort());

/** Explicit reviewed identity assignment uses the ordinary audited entity update.
 * Neither intake, generation nor automatic rule application submits this judgment. */
// oxlint-disable-next-line complexity -- Distinct, existing-owner and assignment judgments share one reviewed closure and ordered atomic lock boundary.
export async function resolveSourceIdentity(
  tx: DrizzleTransaction,
  observationId: SourceTransactionRecordId,
  input: SourceIdentityResolution,
  actor: ActorContext,
): Promise<{ source: string; chargeKey: string }> {
  const db = unwrapDb(tx);
  const [initial] = await db
    .select()
    .from(sourceTransactionRecord)
    .where(eq(sourceTransactionRecord.id, observationId));
  if (!initial || initial.deletedAt)
    return constraintViolation(
      "The reviewed source observation is no longer live.",
    );
  await lockFinancialEvidenceKeys(tx, "source", [initial.source]);
  const initialOwners = await db
    .select()
    .from(sourceOccurrence)
    .where(
      or(
        eq(sourceOccurrence.id, initial.occurrenceId),
        input.decision === "assign"
          ? eq(sourceOccurrence.shortcode, input.occurrenceId)
          : undefined,
      ) ?? sql`false`,
    );
  const [chosenTransaction] =
    input.decision === "accept_existing"
      ? await db
          .select()
          .from(financialTransaction)
          .where(eq(financialTransaction.shortcode, input.transactionId))
          .then((rows) => rows.map(transactionDollars))
      : [];
  await lockFinancialEvidenceKeys(tx, "reviewed-booking", [
    ...initialOwners.flatMap((owner) =>
      owner.acceptedTransactionId
        ? [`transaction:${owner.acceptedTransactionId}`]
        : [],
    ),
    ...(chosenTransaction ? [`transaction:${chosenTransaction.id}`] : []),
  ]);
  const owners = initialOwners.length
    ? await db
        .select()
        .from(sourceOccurrence)
        .where(
          inArray(
            sourceOccurrence.id,
            initialOwners.map((owner) => owner.id),
          ),
        )
        .orderBy(asc(sourceOccurrence.id))
        .for("update")
    : [];
  const [observation] = await db
    .select()
    .from(sourceTransactionRecord)
    .where(eq(sourceTransactionRecord.id, observationId))
    .for("update");
  if (
    !observation ||
    observation.deletedAt ||
    observation.occurrenceId !== initial.occurrenceId ||
    observation.factFingerprint !== input.expectedFactFingerprint
  )
    return constraintViolation(
      "Source evidence changed after review. Read the current evidence before resolving identity.",
    );
  const originalOwner = owners.find(
    (owner) => owner.id === observation.occurrenceId,
  );
  if (!originalOwner)
    return constraintViolation("Every bank record must have a judgment owner.");
  if (
    originalOwner.version !== input.expectedOccurrenceVersion ||
    owners.some(
      (owner) =>
        owner.acceptedTransactionId !==
        initialOwners.find((before) => before.id === owner.id)
          ?.acceptedTransactionId,
    )
  )
    return constraintViolation("Source ownership changed after review.");
  const [priorAccepted] = originalOwner.acceptedTransactionId
    ? await db
        .select({ code: financialTransaction.shortcode })
        .from(financialTransaction)
        .where(eq(financialTransaction.id, originalOwner.acceptedTransactionId))
    : [];
  if ((priorAccepted?.code ?? null) !== input.expectedAcceptedTransactionId)
    return constraintViolation(
      "The accepted transaction changed after review.",
    );
  if (originalOwner.deletedAt || originalOwner.supersededByOccurrenceId)
    return constraintViolation(
      "Retired or replaced source identity must retain its reservation.",
    );
  const owner =
    input.decision === "assign"
      ? owners.find((candidate) => candidate.shortcode === input.occurrenceId)
      : originalOwner;
  if (
    input.decision === "assign" &&
    (owner?.id === originalOwner.id ||
      !owner ||
      owner.identityKind !== "provider" ||
      !owner.currentObservationId ||
      !["unproven", "positioned", "reviewed"].includes(
        originalOwner.identityKind,
      ) ||
      ![
        "unproven",
        "ready",
        "identity_conflict",
        "ownership_conflict",
      ].includes(originalOwner.reviewState) ||
      owner.source !== observation.source ||
      owner.version !== input.expectedTargetVersion ||
      !["ready", "identity_conflict"].includes(owner.reviewState) ||
      owner.deletedAt ||
      owner.withdrawnAt ||
      owner.supersededByOccurrenceId)
  )
    return constraintViolation(
      "Consolidate only an unproven, positioned or reviewed owner into a current provider occurrence from the same source.",
    );
  const [account] = await db
    .select()
    .from(financialAccount)
    .where(
      and(
        eq(financialAccount.shortcode, input.accountId),
        notDeleted(financialAccount),
      ),
    )
    .for("key share");
  if (!account)
    return constraintViolation(
      "The reviewed source account is no longer live.",
    );
  const financialJudgment =
    input.judgment.disposition === "open"
      ? {
          disposition: "open" as const,
          dispositionReason: null,
          dispositionNote: null,
        }
      : input.judgment;
  if (originalOwner.withdrawnAt && input.decision !== "assign") {
    const positive = await db.execute(
      sql`SELECT 1 FROM ${transactionImportRecord} member
      JOIN "TransactionImport" collection ON collection.id=member."importId" AND ${notDeleted("collection")}
      WHERE member."statementRowId"=${observation.id}::uuid AND collection."observedAt">${originalOwner.withdrawnAt} LIMIT 1`,
      "objects",
    );
    if (!positive.length)
      return constraintViolation(
        "A confirmed withdrawal needs retained positive source evidence from after its proof before reappearance can be confirmed.",
      );
  }
  if (!owner)
    return constraintViolation("The reviewed target owner is missing.");
  if (originalOwner.disposition !== input.expectedDisposition)
    return constraintViolation("The source disposition changed after review.");
  if (
    input.decision === "assign" &&
    (originalOwner.accountId !== owner.accountId ||
      originalOwner.disposition !== owner.disposition ||
      originalOwner.dispositionReason !== owner.dispositionReason ||
      originalOwner.dispositionNote !== owner.dispositionNote ||
      owner.accountId !== account.id ||
      financialJudgment.disposition !== owner.disposition ||
      financialJudgment.dispositionReason !== owner.dispositionReason ||
      financialJudgment.dispositionNote !== owner.dispositionNote ||
      originalOwner.withdrawnAt ||
      originalOwner.replacementObservationId ||
      (originalOwner.acceptedTransactionId &&
        owner.acceptedTransactionId &&
        originalOwner.acceptedTransactionId !== owner.acceptedTransactionId))
  )
    return constraintViolation(
      "Resolve conflicting account, ignore, lifecycle or accepted transaction judgments before consolidation.",
    );
  // Ordered owner locks and versions fence the complete closure against serializable intake.
  const closure = await db
    .select()
    .from(sourceTransactionRecord)
    .where(eq(sourceTransactionRecord.occurrenceId, originalOwner.id))
    .orderBy(sourceTransactionRecord.id)
    .for("update");
  const [head] = owner.currentObservationId
    ? await db
        .select()
        .from(sourceTransactionRecord)
        .where(eq(sourceTransactionRecord.id, owner.currentObservationId))
        .for("update")
    : [];
  if (input.decision === "assign") {
    if (
      !head ||
      head.deletedAt ||
      closure.some((record) => {
        const claims = providerIdentityClaims(
          z.json().parse(record.providerData),
        );
        return (
          claims.malformed ||
          record.amount !== head.amount ||
          record.deletedAt ||
          (record.providerAccountId !== null &&
            record.providerAccountId !== head.providerAccountId) ||
          (record.providerTransactionId !== null &&
            record.providerTransactionId !== head.providerTransactionId) ||
          claims.accounts.some((id) => id !== head.providerAccountId) ||
          claims.providerIds.some((id) => id !== head.providerTransactionId)
        );
      })
    )
      return constraintViolation(
        "Consolidation needs equal amounts, compatible provider identity and live evidence across the complete closure.",
      );
    const replacements = await db
      .select({ id: sourceOccurrence.id })
      .from(sourceOccurrence)
      .where(
        and(
          eq(sourceOccurrence.supersededByOccurrenceId, originalOwner.id),
          isNotNull(sourceOccurrence.replacementObservationId),
        ),
      );
    if (replacements.length)
      return constraintViolation(
        "Another owner names an exact replacement in this closure; resolve that replacement before consolidation.",
      );
  }
  const history = await db.execute<{ id: string; code: string }>(
    sql`
    SELECT * FROM (${sourceHistoricalTransactionRows(
      sql`${observation.id}::uuid`,
      sql`ARRAY[${sql.join(
        owners.map((item) => sql`${item.id}::uuid`),
        sql`, `,
      )}]::uuid[]`,
    )}) history ORDER BY history.id`,
    "objects",
  );
  if (
    !sameSet(
      history.map((item) => item.code),
      input.historicalTransactionIds,
    )
  )
    return constraintViolation(
      "Historical transaction evidence changed. Review every retained live binding before resolving source identity.",
    );
  const targetId =
    input.decision === "accept_existing"
      ? chosenTransaction?.id
      : input.decision === "assign"
        ? (owner.acceptedTransactionId ?? originalOwner.acceptedTransactionId)
        : null;
  const [target] = targetId
    ? await db
        .select()
        .from(financialTransaction)
        .where(eq(financialTransaction.id, targetId))
        .for("update")
        .then((rows) => rows.map(transactionDollars))
    : [];
  if (
    targetId &&
    (!target ||
      target.deletedAt ||
      target.status === "void" ||
      target.accountId !== account.id ||
      financialEvidenceAmountMinor(target.amount) !== observation.amount ||
      (input.decision === "assign" &&
        (!head || head.amount !== financialEvidenceAmountMinor(target.amount))))
  )
    return constraintViolation(
      "The chosen transaction must be live and match the exact reviewed source account and amount.",
    );
  if (input.decision === "accept_existing" && !target)
    return constraintViolation("The chosen transaction is no longer live.");
  if (input.decision === "assign") {
    const conflicts = await db.execute(
      sql`
      SELECT 1 FROM "FinancialEvidenceAlias" evidence
      JOIN "FinancialEvidenceAlias" binding ON binding.source=evidence.source AND binding.value=evidence.value AND ${notDeleted("binding")}
      JOIN "FinancialTransaction" money ON money.id=binding."historicalTransactionId" AND ${notDeleted("money")}
      WHERE evidence."occurrenceId" IN (${originalOwner.id}::uuid, ${owner.id}::uuid)
        AND money.id IS DISTINCT FROM ${target?.id ?? null}::uuid LIMIT 1`,
      "objects",
    );
    if (conflicts.length)
      return constraintViolation(
        "A direct historical binding names different live money; consolidation cannot resolve it implicitly.",
      );
  }
  const priorProof = z
    .object({ originalIdentityProof: z.json() })
    .passthrough()
    .safeParse(owner.identityProof);
  const proof = jsonSnapshot.parse({
    originalIdentityProof: priorProof.success
      ? priorProof.data.originalIdentityProof
      : (owner.identityProof ?? null),
    resolvedHistoricalTransactionIds: history.map((item) => item.id),
    resolution: {
      decision: input.decision,
      observationId: observation.id,
      factFingerprint: observation.factFingerprint,
      accountId: account.id,
      acceptedTransactionId: target?.id ?? null,
      note: input.note,
      expectedDisposition: input.expectedDisposition,
      judgment: input.judgment,
      priorWithdrawal: {
        at: originalOwner.withdrawnAt,
        importId: originalOwner.withdrawalImportId,
      },
      userId: actor.userId,
      at: new Date().toISOString(),
    },
  });
  const beforeOwners =
    input.decision === "assign" ? [originalOwner, owner] : [owner];
  const beforeAliases = await db
    .select()
    .from(financialEvidenceAlias)
    .where(
      inArray(
        financialEvidenceAlias.occurrenceId,
        owners.map((item) => item.id),
      ),
    );
  if (
    originalOwner.acceptedTransactionId &&
    (input.decision === "assign" ||
      originalOwner.acceptedTransactionId !== (target?.id ?? null))
  ) {
    await db.insert(financialEvidenceAlias).values({
      source: originalOwner.source,
      kind: "transaction_ref",
      value: originalOwner.shortcode,
      observationId: originalOwner.currentObservationId,
      occurrenceId: originalOwner.id,
      historicalTransactionId: originalOwner.acceptedTransactionId,
      provenanceKey: `reviewed-owner-release:${originalOwner.id}:${originalOwner.version}`,
      provenance: jsonSnapshot.parse({
        kind: "reviewed_owner_release",
        note: input.note,
        userId: actor.userId,
        previousOwner: originalOwner,
      }),
      scopeEvidence: jsonSnapshot.parse({
        identityKind: originalOwner.identityKind,
        identityScope: originalOwner.identityScope,
      }),
      deletedAt: new Date(),
    });
  }
  let retired = originalOwner;
  if (input.decision === "assign") {
    // Immediate membership FKs require clearing the old head before moving any record.
    const [released] = await db
      .update(sourceOccurrence)
      .set({
        currentObservationId: null,
        accountId: null,
        acceptedTransactionId: null,
        supersededByOccurrenceId: owner.id,
        replacementObservationId: null,
        identityProof: jsonSnapshot.parse({
          kind: "consolidated",
          previousOwner: originalOwner,
          survivorId: owner.id,
          note: input.note,
          userId: actor.userId,
        }),
        version: originalOwner.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(sourceOccurrence.id, originalOwner.id))
      .returning();
    if (!released) return constraintViolation("The retired owner disappeared.");
    retired = released;
    await db
      .update(sourceTransactionRecord)
      .set({ occurrenceId: owner.id })
      .where(eq(sourceTransactionRecord.occurrenceId, originalOwner.id));
    await db
      .update(financialEvidenceAlias)
      .set({ occurrenceId: owner.id })
      .where(eq(financialEvidenceAlias.occurrenceId, originalOwner.id));
    await transitionSuggestionStates(
      databaseForTransaction(tx),
      and(
        eq(suggestionTable.family, "statement_transaction"),
        eq(suggestionTable.status, "pending"),
        suggestionTable.active,
        inArray(
          suggestionTable.recordId,
          closure.map((record) => record.id),
        ),
        sql`${suggestionTable.data}->>'chargeKey'=${originalOwner.shortcode}`,
      ),
      { active: false, status: "superseded" },
    );
  }
  const { rows: overlaps } =
    input.decision === "assign"
      ? await db.execute<{
          remaining: boolean;
        }>(sql`-- includes-deleted: retained legacy records and identity reservations still fence duplicate acceptance.
        SELECT EXISTS (
        SELECT 1 FROM "SourceTransactionRecord" record
        JOIN "SourceOccurrence" other ON other.id=record."occurrenceId"
        WHERE record.source=${owner.source} AND record."providerTransactionId"=${owner.providerIdentity}
          AND record."occurrenceId"<>${owner.id}::uuid AND other."identityKind"<>${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.provider)}
      ) OR
        -- includes-deleted: retained alias overlaps still fence unresolved identities after tombstoning.
      EXISTS (
        SELECT 1 FROM "FinancialEvidenceAlias" own
        JOIN "FinancialEvidenceAlias" sibling ON sibling.source=own.source AND sibling.value=own.value
        JOIN "SourceTransactionRecord" record ON record.id=sibling."observationId"
        JOIN "SourceOccurrence" other ON other.id=record."occurrenceId"
        WHERE own."occurrenceId"=${owner.id}::uuid AND record."occurrenceId"<>${owner.id}::uuid
          AND other."identityKind"<>${sqlEnumConstant(sourceOccurrenceIdentityKind, sourceOccurrenceIdentityKind.enum.provider)}
      ) AS remaining`)
      : { rows: [] };
  const [updatedOwner] = await db
    .update(sourceOccurrence)
    .set({
      lastObservedAt:
        owner.lastObservedAt > originalOwner.lastObservedAt
          ? owner.lastObservedAt
          : originalOwner.lastObservedAt,
      currentObservationId:
        input.decision === "assign"
          ? owner.currentObservationId
          : observation.id,
      accountId: account.id,
      ...financialJudgment,
      acceptedTransactionId: target?.id ?? null,
      ...(owner.identityKind === "unproven" && input.decision !== "assign"
        ? { identityKind: "reviewed" as const }
        : {}),
      // Consolidation does not waive other overlaps or unlock a conflicted provider.
      reviewState:
        input.decision === "assign" && overlaps[0]?.remaining
          ? "identity_conflict"
          : "ready",
      withdrawnAt: input.decision === "assign" ? owner.withdrawnAt : null,
      withdrawalImportId:
        input.decision === "assign" ? owner.withdrawalImportId : null,
      identityProof: proof,
      version: owner.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(sourceOccurrence.id, owner.id))
    .returning();
  const updatedObservations = await db
    .select()
    .from(sourceTransactionRecord)
    .where(
      inArray(
        sourceTransactionRecord.id,
        closure.map((record) => record.id),
      ),
    );
  const afterAliases = await db
    .select()
    .from(financialEvidenceAlias)
    .where(
      inArray(
        financialEvidenceAlias.occurrenceId,
        owners.map((item) => item.id),
      ),
    );
  if (!updatedOwner || updatedObservations.length !== closure.length)
    return constraintViolation(
      "Source resolution did not retain its evidence rows.",
    );
  const ownerSnapshot = (
    item: typeof sourceOccurrence.$inferSelect,
    aliases: typeof beforeAliases,
  ) => ({
    ...item,
    aliases: aliases.filter((alias) => alias.occurrenceId === item.id),
  });
  await auditEvidenceRows(
    tx,
    actor,
    "sourceOccurrence",
    beforeOwners.map((item) => ownerSnapshot(item, beforeAliases)),
    [...(input.decision === "assign" ? [retired] : []), updatedOwner].map(
      (item) => ownerSnapshot(item, afterAliases),
    ),
  );
  const recordSnapshot = (
    record: typeof sourceTransactionRecord.$inferSelect,
    aliases: typeof beforeAliases,
  ) => ({
    id: record.id,
    occurrenceId: record.occurrenceId,
    aliases: aliases.filter((alias) => alias.observationId === record.id),
  });
  await auditEvidenceRows(
    tx,
    actor,
    "sourceTransactionRecord",
    closure.map((record) => recordSnapshot(record, beforeAliases)),
    updatedObservations.map((record) => recordSnapshot(record, afterAliases)),
  );
  await recordChange(tx, { kind: "source", categories: [] });
  return { source: owner.source, chargeKey: owner.shortcode };
}
