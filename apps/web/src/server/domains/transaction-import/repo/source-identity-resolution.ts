import type { ActorContext } from "@cubby/schemas/context";
import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import type { SourceIdentityResolution } from "@cubby/schemas/source-occurrence-fields";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { sourceHistoricalTransactionRows } from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import {
  financialAccount,
  financialEvidenceAlias,
  financialTransaction,
  sourceOccurrence,
  sourceObservationAnnotation,
  sourceTransactionRecord,
} from "~/server/db/schema";
import {
  financialEvidenceAmountMinor,
  lockFinancialEvidenceKeys,
} from "~/server/domains/financial-transaction/repo/financial-evidence";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { jsonSnapshot } from "~/server/lib/canonical-json";

import { auditEvidenceRows } from "./intake-audit";

const refuse = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
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
    return refuse("The reviewed source observation is no longer live.");
  await lockFinancialEvidenceKeys(tx, "source", [initial.source]);
  const initialOwners = await db
    .select()
    .from(sourceOccurrence)
    .where(
      or(
        initial.occurrenceId
          ? eq(sourceOccurrence.id, initial.occurrenceId)
          : undefined,
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
    return refuse(
      "Source evidence changed after review. Read the current evidence before resolving identity.",
    );
  const originalOwner = owners.find(
    (owner) => owner.id === observation.occurrenceId,
  );
  if (
    (originalOwner?.version ?? null) !== input.expectedOccurrenceVersion ||
    owners.some(
      (owner) =>
        owner.acceptedTransactionId !==
        initialOwners.find((before) => before.id === owner.id)
          ?.acceptedTransactionId,
    )
  )
    return refuse("Source ownership changed after review.");
  const [priorAccepted] = originalOwner?.acceptedTransactionId
    ? await db
        .select({ code: financialTransaction.shortcode })
        .from(financialTransaction)
        .where(eq(financialTransaction.id, originalOwner.acceptedTransactionId))
    : [];
  if ((priorAccepted?.code ?? null) !== input.expectedAcceptedTransactionId)
    return refuse("The accepted transaction changed after review.");
  if (originalOwner?.deletedAt || originalOwner?.supersededByOccurrenceId)
    return refuse(
      "Retired or replaced source identity must retain its reservation.",
    );
  let owner =
    input.decision === "assign"
      ? owners.find((candidate) => candidate.shortcode === input.occurrenceId)
      : originalOwner;
  if (
    input.decision === "assign" &&
    (observation.occurrenceId !== null ||
      !owner ||
      owner.source !== observation.source ||
      owner.version !== input.expectedTargetVersion ||
      owner.reviewState !== "ready" ||
      owner.deletedAt ||
      owner.withdrawnAt ||
      owner.supersededByOccurrenceId)
  )
    return refuse(
      "Assign only unresolved observations to a current reviewed occurrence from the same source.",
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
  if (!account) return refuse("The reviewed source account is no longer live.");
  const financialJudgment =
    input.judgment.disposition === "open"
      ? {
          disposition: "open" as const,
          dispositionReason: null,
          dispositionNote: null,
        }
      : input.judgment;
  if (originalOwner?.withdrawnAt && input.decision !== "assign") {
    const { rows: positive } =
      await db.execute(sql`SELECT 1 FROM "TransactionImportRecord" member
      JOIN "TransactionImport" collection ON collection.id=member."importId" AND ${notDeleted("collection")}
      WHERE member."statementRowId"=${observation.id}::uuid AND collection."observedAt">${originalOwner.withdrawnAt} LIMIT 1`);
    if (!positive.length)
      return refuse(
        "A confirmed withdrawal needs retained positive source evidence from after its proof before reappearance can be confirmed.",
      );
  }
  const [annotation] = await db
    .select()
    .from(sourceObservationAnnotation)
    .where(eq(sourceObservationAnnotation.observationId, observationId))
    .for("update");
  if (!annotation) return refuse("Original source judgments are missing.");
  if (
    (originalOwner?.disposition ?? annotation.disposition) !==
    input.expectedDisposition
  )
    return refuse(
      "The source disposition changed after review. Read the current member judgment before resolving identity.",
    );
  if (
    input.decision === "assign" &&
    (annotation.accountId !== owner?.accountId ||
      annotation.disposition !== owner?.disposition)
  )
    return refuse(
      "The observation account or disposition differs from the target owner; preserve and review both member judgments before assignment.",
    );
  if (
    input.decision === "assign" &&
    (owner?.accountId !== account.id ||
      financialJudgment.disposition !== owner.disposition ||
      financialJudgment.dispositionReason !== owner.dispositionReason ||
      financialJudgment.dispositionNote !== owner.dispositionNote)
  )
    return refuse(
      "Resolve conflicting account or ignore judgments explicitly before assigning the observation.",
    );
  const { rows: history } = await db.execute<{ id: string; code: string }>(sql`
    SELECT * FROM (${sourceHistoricalTransactionRows(
      sql`${observation.id}::uuid`,
      sql`ARRAY[${sql.join(
        owners.map((item) => sql`${item.id}::uuid`),
        sql`, `,
      )}]::uuid[]`,
    )}) history ORDER BY history.id`);
  if (
    !sameSet(
      history.map((item) => item.code),
      input.historicalTransactionIds,
    )
  )
    return refuse(
      "Historical transaction evidence changed. Review every retained live binding before resolving source identity.",
    );
  const targetId =
    input.decision === "accept_existing"
      ? chosenTransaction?.id
      : input.decision === "assign"
        ? owner?.acceptedTransactionId
        : null;
  const [target] = targetId
    ? await db
        .select()
        .from(financialTransaction)
        .where(eq(financialTransaction.id, targetId))
        .for("update")
    : [];
  if (
    targetId &&
    (!target ||
      target.deletedAt ||
      target.status === "void" ||
      target.accountId !== account.id ||
      financialEvidenceAmountMinor(target.amount) !== observation.amount)
  )
    return refuse(
      "The chosen transaction must be live and match the exact reviewed source account and amount.",
    );
  if (input.decision === "accept_existing" && !target)
    return refuse("The chosen transaction is no longer live.");
  const priorProof = z
    .object({ originalIdentityProof: z.json() })
    .passthrough()
    .safeParse(owner?.identityProof);
  const proof = jsonSnapshot.parse({
    originalIdentityProof: priorProof.success
      ? priorProof.data.originalIdentityProof
      : (owner?.identityProof ?? null),
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
      priorWithdrawal: originalOwner
        ? {
            at: originalOwner.withdrawnAt,
            importId: originalOwner.withdrawalImportId,
          }
        : null,
      userId: actor.userId,
      at: new Date().toISOString(),
    },
  });
  const createdOwner = !owner;
  if (!owner)
    owner = await insertWithShortcode(tx, "sourceOccurrence", {
      source: observation.source,
      identityKind: "reviewed",
      identityScope: `reviewed-observation:${observation.id}`,
      accountId: account.id,
      ...financialJudgment,
      identityProof: proof,
      currentObservationId: null,
      lastObservedAt: annotation.lastObservedAt,
      reviewState: "ready",
    });
  const beforeOwners = originalOwner
    ? [originalOwner]
    : input.decision === "assign"
      ? [owner]
      : [];
  const beforeAliases = await db
    .select()
    .from(financialEvidenceAlias)
    .where(eq(financialEvidenceAlias.observationId, observation.id));
  if (
    originalOwner?.acceptedTransactionId &&
    originalOwner.acceptedTransactionId !== (target?.id ?? null)
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
  await db
    .update(sourceTransactionRecord)
    .set({ occurrenceId: owner.id })
    .where(eq(sourceTransactionRecord.id, observation.id));
  await db
    .update(financialEvidenceAlias)
    .set({ occurrenceId: owner.id })
    .where(eq(financialEvidenceAlias.observationId, observation.id));
  const [updatedOwner] = await db
    .update(sourceOccurrence)
    .set({
      currentObservationId:
        input.decision === "assign"
          ? owner.currentObservationId
          : observation.id,
      accountId: account.id,
      ...financialJudgment,
      acceptedTransactionId: target?.id ?? null,
      reviewState: "ready",
      withdrawnAt: input.decision === "assign" ? owner.withdrawnAt : null,
      withdrawalImportId:
        input.decision === "assign" ? owner.withdrawalImportId : null,
      identityProof: proof,
      version: owner.version + (createdOwner ? 0 : 1),
      updatedAt: new Date(),
    })
    .where(eq(sourceOccurrence.id, owner.id))
    .returning();
  const [updatedObservation] = await db
    .select()
    .from(sourceTransactionRecord)
    .where(eq(sourceTransactionRecord.id, observation.id));
  const afterAliases = await db
    .select()
    .from(financialEvidenceAlias)
    .where(eq(financialEvidenceAlias.observationId, observation.id));
  if (!updatedOwner || !updatedObservation)
    return refuse("Source resolution did not retain its evidence rows.");
  await auditEvidenceRows(tx, actor, "sourceOccurrence", beforeOwners, [
    updatedOwner,
  ]);
  await auditEvidenceRows(
    tx,
    actor,
    "sourceTransactionRecord",
    [
      {
        id: observation.id,
        occurrenceId: observation.occurrenceId,
        aliases: beforeAliases,
      },
    ],
    [
      {
        id: updatedObservation.id,
        occurrenceId: updatedObservation.occurrenceId,
        aliases: afterAliases,
      },
    ],
  );
  await recordChange(tx, { kind: "source", categories: [] });
  return { source: owner.source, chargeKey: owner.shortcode };
}
