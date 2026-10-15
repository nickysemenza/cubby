import type { EmailExecutionPolicy } from "@cubby/schemas/email-fields";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { email as emailTable, ledgerParty, run } from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";

import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";

/** Refresh does not transfer, repair or readmit an assigned import source. */
async function classificationRefreshDisposition(
  db: Database,
  email: typeof emailTable.$inferSelect,
) {
  if (!email.runId) return "refresh";
  const [owner] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, email.runId))
    .limit(1);
  if (owner?.purpose === "mail_discovery") return "refresh";
  if (
    owner?.purpose !== "mail_import" ||
    owner.ledgerPartyId !== email.ledgerPartyId
  )
    return "historical";
  const frozen = mailResearchRunInput.safeParse(owner.input);
  if (!frozen.success || !email.orderMailId) return "historical";
  const source = frozen.data.sources.find(
    (candidate) =>
      candidate.orderMailId === email.orderMailId &&
      candidate.checksum === email.checksum,
  );
  if (!source) return "historical";
  const [original] = await readRetainedMail(db, {
    ledgerPartyIds: [email.ledgerPartyId],
    mailboxId: email.mailboxId,
    messageId: email.messageId,
    orderMailIds: [source.orderMailId],
  });
  return original?.rawChecksum === source.checksum ? "frozen" : "historical";
}

export async function deferClassificationRefresh(
  db: Database,
  policy: EmailExecutionPolicy,
  email: typeof emailTable.$inferSelect | null,
) {
  if (policy !== "classification_only" || !email?.runId) return false;
  return (await classificationRefreshDisposition(db, email)) !== "refresh";
}

function emailPublicationChanged(
  current: typeof emailTable.$inferSelect | null,
  expected: typeof emailTable.$inferSelect | null,
) {
  if (!expected) return Boolean(current);
  if (!current) return true;
  const fields = [
    "id",
    "runId",
    "checksum",
    "orderMailId",
    "status",
    "classification",
    "classificationVersion",
    "classificationStage",
    "classificationReason",
  ] as const;
  return (
    fields.some((key) => current[key] !== expected[key]) ||
    current.updatedAt.getTime() !== expected.updatedAt.getTime() ||
    current.contentClearedAt?.getTime() !== expected.contentClearedAt?.getTime()
  );
}

/** Provider/model IO is complete. Admission wins before this publication boundary. */
export async function publishGmailEvidence<T>(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    runId?: string;
    executionPolicy: EmailExecutionPolicy;
    expected: typeof emailTable.$inferSelect | null;
    /** Extraction-preview publication is auxiliary evidence, not message handling. */
    recordHandlingReceipt?: boolean;
    observationId?: string | null;
    evaluation?: {
      id: string;
      token: string;
      sourceChecksum?: string;
      reclassification?: boolean;
      removed?: boolean;
      observationId?: string | null;
    };
  },
  publish: (
    tx: Database,
    current: typeof emailTable.$inferSelect | null,
  ) => Promise<T>,
): Promise<T | null> {
  return withTransaction(db, async (tx) => {
    const evaluation = input.evaluation;
    const guarded = evaluation
      ? await (
          await import("~/server/ai/repo/ai-evaluation")
        ).guardAiEvaluation(
          databaseForTransaction(tx),
          evaluation.id,
          evaluation.token,
        )
      : null;
    const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
    const [party] = await tx
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(and(eq(ledgerParty.id, partyId), notDeleted(ledgerParty)))
      .for("no key update");
    const decline = async (
      reason: "removed" | "frozen" | "changed",
      current: typeof emailTable.$inferSelect | null,
    ) => {
      if (input.recordHandlingReceipt !== false)
        await (
          await import("~/server/domains/email/repo/discovery-email-audit")
        ).recordDiscoveryEmailReceipt(databaseForTransaction(tx), {
          ...input,
          outcome: reason,
        });
      if (!evaluation || !guarded) return null;
      const { completeAiEvaluation } =
        await import("~/server/ai/repo/ai-evaluation");
      if (!evaluation.reclassification) {
        await completeAiEvaluation(
          databaseForTransaction(tx),
          evaluation.id,
          evaluation.token,
          {
            reason: `source_${reason}`,
            sourceChecksum: current?.checksum ?? null,
          },
          "blocked",
        );
        return null;
      }
      const result = {
        id:
          input.expected?.shortcode ??
          current?.shortcode ??
          (
            await import("./reclassification-work")
          ).reclassificationSnapshot.parse(guarded.row.snapshot).publicId,
        outcome: reason,
        classification: null,
        stage: null,
        conflict: false,
        error: null,
      };
      if (reason === "changed" && current) {
        if (guarded.row.restarts < 2) {
          const { aiEvaluation } = await import("~/server/db/schema");
          await tx
            .update(aiEvaluation)
            .set({
              state: "retry_wait",
              restarts: guarded.row.restarts + 1,
              attempts: guarded.row.attempts - 1,
              result: null,
              deadlineAt: null,
              nextAttemptAt: new Date(Date.now() + 1_000),
              error:
                "Email evidence changed; continuing with its latest evidence",
            })
            .where(
              and(
                eq(aiEvaluation.id, evaluation.id),
                eq(aiEvaluation.attemptToken, evaluation.token),
              ),
            );
        } else {
          // Release the pending key before registering the next generation's demand.
          await completeAiEvaluation(
            databaseForTransaction(tx),
            evaluation.id,
            evaluation.token,
            { result },
            "obsolete",
          );
          const continuationRunIds = await (
            await import("./reclassification-continuation")
          ).continueChangedReclassification(
            databaseForTransaction(tx),
            guarded.row,
            current,
          );
          await completeAiEvaluation(
            databaseForTransaction(tx),
            evaluation.id,
            evaluation.token,
            { result, continuationRunIds },
            "obsolete",
          );
        }
      } else
        await completeAiEvaluation(
          databaseForTransaction(tx),
          evaluation.id,
          evaluation.token,
          { result },
          reason === "frozen" ? "blocked" : "completed",
        );
      return null;
    };
    if (!party) return decline("removed", null);
    const runIds = [
      ...new Set(
        [input.runId, input.expected?.runId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ].map((id) => runEntityId.parse(id));
    if (runIds.length)
      await tx
        .select({ id: run.id })
        .from(run)
        .where(inArray(run.id, runIds))
        .orderBy(asc(run.id))
        .for("update");
    const [current] = await tx
      .select()
      .from(emailTable)
      .where(
        and(
          eq(emailTable.ledgerPartyId, partyId),
          eq(emailTable.provider, "gmail"),
          eq(emailTable.mailboxId, input.mailboxId),
          eq(emailTable.messageId, input.messageId),
          notDeleted(emailTable),
        ),
      )
      .for("update")
      .limit(1);
    if (emailPublicationChanged(current ?? null, input.expected))
      return decline(current ? "changed" : "removed", current ?? null);
    const txDb = databaseForTransaction(tx);
    if (
      current?.classificationVersion ===
        HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION ||
      (await deferClassificationRefresh(
        txDb,
        input.executionPolicy,
        current ?? null,
      ))
    )
      return decline("frozen", current ?? null);
    const result = await publish(txDb, current ?? null);
    if (input.recordHandlingReceipt !== false)
      await (
        await import("~/server/domains/email/repo/discovery-email-audit")
      ).recordDiscoveryEmailReceipt(txDb, {
        ...input,
        observationId: input.observationId ?? evaluation?.observationId,
        outcome: evaluation?.removed ? "removed" : undefined,
      });
    if (evaluation)
      await (
        await import("~/server/ai/repo/ai-evaluation")
      ).completeAiEvaluation(
        txDb,
        evaluation.id,
        evaluation.token,
        evaluation.reclassification && input.expected && input.runId
          ? await (
              await import("./reclassification-receipt")
            ).reclassificationReceipt(
              txDb,
              input.expected,
              evaluation.observationId ?? null,
              result,
              evaluation.removed,
            )
          : {
              outcome: result,
              sourceChecksum: evaluation.sourceChecksum ?? null,
            },
      );
    return result;
  });
}
