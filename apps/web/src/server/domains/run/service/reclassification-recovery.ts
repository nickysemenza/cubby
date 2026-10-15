import { buildActorContext } from "@cubby/schemas/context";
import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { aiEvaluation, email, run, runOperation } from "~/server/db/schema";
import { deferClassificationRefresh } from "~/server/domains/purchase-import/gmail/admitted-source";
import { prepareReclassification } from "~/server/domains/purchase-import/gmail/reclassification-work";
import { mailboxApproval } from "~/server/domains/purchase-import/gmail/reclassify";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/mail-source-identity";

import { ensureRun } from "./ensure-run";
import { assertExecutionAuthorization } from "./execution-authorization";
import { executionRequestForRun } from "./execution-context";

const OPERATION = "reclassification-recovery-v1";
const fulfilled = new Set([
  "replaced",
  "confirmed",
  "awaiting_acceptance",
  "resolution_kept",
]);

/** One-shot reconciliation records its decision separately from immutable old Run receipts. */
export async function recoverHistoricalReclassification(db: Database) {
  let cursor: Pick<typeof run.$inferSelect, "createdAt" | "id"> | undefined;
  for (;;) {
    const sources = await getDb(db)
      .select()
      .from(run)
      .where(
        and(
          sql`${run.input}->>${mailReclassifyRunInput.keyof().enum.kind} = ${mailReclassifyRunInput.shape.kind.value} AND ${run.input}->>${mailReclassifyRunInput.keyof().enum.mode} = ${mailReclassifyRunInput.shape.mode.enum.relevance}`,
          or(
            inArray(run.status, ["completed", "failed"]),
            and(
              eq(run.status, "needs_review"),
              eq(run.failureCode, "execution_limit"),
            ),
          ),
          notDeleted(run),
          sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
          cursor
            ? sql`(${run.createdAt}, ${run.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)`
            : undefined,
          sql`NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" AS request WHERE request."runId" = "Run".id)`,
          sql`NOT EXISTS (SELECT 1 FROM "RunOperation" AS recovered WHERE recovered."runId" = "Run".id AND recovered."operationId" = ${OPERATION})`,
        ),
      )
      .orderBy(run.createdAt, run.id)
      .limit(25);
    for (const source of sources) {
      const parsed = mailReclassifyRunInput.safeParse(source.input);
      if (!parsed.success) continue;
      const input = parsed.data;
      const checkpoint = mailReclassificationCheckpoint.safeParse(
        source.progress,
      );
      const originals = await getDb(db)
        .select()
        .from(email)
        .where(
          and(
            inArray(
              email.id,
              input.emails.map((item) => item.emailId),
            ),
            notDeleted(email),
          ),
        );
      const candidates: (typeof email.$inferSelect)[] = [];
      for (const item of originals) {
        if (
          item.ledgerPartyId !== source.ledgerPartyId ||
          item.mailboxId !== input.mailboxId ||
          item.provider !== "gmail" ||
          item.classificationVersion ===
            HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION ||
          (await deferClassificationRefresh(db, "classification_only", item))
        )
          continue;
        const receipt = checkpoint.success
          ? checkpoint.data.results.find((entry) => entry.id === item.shortcode)
          : null;
        if (
          receipt &&
          !["deferred", "failed", "changed"].includes(receipt.outcome)
        )
          continue;
        // A known invalid target is terminal. Read-back/storage failures remain ambiguous.
        if (
          receipt?.outcome === "failed" &&
          /outside.*(?:mailbox|roster)|different member|invalid argument|schema validation/i.test(
            receipt.error ?? "",
          )
        )
          continue;
        const [later] = await getDb(db)
          .select({ receipt: aiEvaluation.receipt })
          .from(aiEvaluation)
          .where(
            and(
              eq(aiEvaluation.executionKind, "mail_reclassify"),
              sql`${aiEvaluation.target}->>'recordId' = ${item.id}`,
              gt(aiEvaluation.createdAt, source.createdAt),
              inArray(aiEvaluation.state, ["completed", "blocked"]),
              sql`${aiEvaluation.receipt}->>'sourceChecksum' = ${item.checksum}`,
            ),
          )
          .limit(1);
        if (later) continue;
        const laterLegacy = await getDb(db)
          .select({ input: run.input, progress: run.progress })
          .from(run)
          .where(
            and(
              gt(run.createdAt, source.createdAt),
              eq(run.status, "completed"),
              eq(run.ledgerPartyId, item.ledgerPartyId),
              sql`${run.input}->>${mailReclassifyRunInput.keyof().enum.kind} = ${mailReclassifyRunInput.shape.kind.value} AND ${run.input}->>${mailReclassifyRunInput.keyof().enum.mode} = ${mailReclassifyRunInput.shape.mode.enum.relevance}`,
            ),
          )
          .orderBy(desc(run.createdAt));
        if (
          laterLegacy.some((laterRun) => {
            const roster = mailReclassifyRunInput.safeParse(laterRun.input);
            const receipts = mailReclassificationCheckpoint.safeParse(
              laterRun.progress,
            );
            return (
              roster.success &&
              roster.data.emails.some(
                (entry) =>
                  entry.emailId === item.id && entry.checksum === item.checksum,
              ) &&
              receipts.success &&
              receipts.data.results.some(
                (entry) =>
                  entry.id === item.shortcode && fulfilled.has(entry.outcome),
              )
            );
          })
        )
          continue;
        candidates.push(item);
      }
      let authorization = input.executionAuthorization;
      if (candidates.length) {
        try {
          const request = await executionRequestForRun(db, source.id);
          if (!request)
            throw new Error(
              "Historical reclassification has no authority binding",
            );
          await assertExecutionAuthorization(db, request);
        } catch {
          // SILENT: unusable old authority is replaced only by an applicable current approval.
          if (!source.ledgerPartyId) continue;
          try {
            authorization = await mailboxApproval(
              db,
              {
                userId: source.actorUserId,
                ledgerPartyId: source.ledgerPartyId,
              },
              input.mailboxId,
              { newest: true },
            );
          } catch {
            // SILENT: preserve unknown historical work for a later approval wake.
            continue;
          }
        }
      }
      await withTransactionDatabase(db, async (tx) => {
        await getDb(tx)
          .select({ id: run.id })
          .from(run)
          .where(eq(run.id, source.id))
          .for("update");
        const [recorded] = await getDb(tx)
          .select({ id: runOperation.id })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, source.id),
              eq(runOperation.operationId, OPERATION),
            ),
          );
        if (recorded) return;
        let continuationRunId = null;
        if (candidates.length && authorization) {
          const actor = buildActorContext(source.actorUserId, source.channel, {
            oauthClientId: source.oauthClientId,
            deviceId: source.deviceId,
          });
          continuationRunId = await ensureRun(tx, actor, {
            purpose: "mail_reclassify",
            trigger: "manual",
            cause: "retry",
            parentRunId: source.id,
            clientKey: `reclassification-recovery:${source.id}`,
            input: {
              ...input,
              executionAuthorization: authorization,
              emails: candidates.map((item) => ({
                emailId: item.id,
                checksum: item.checksum,
              })),
            },
            progress: {
              kind: "mail_reclassification",
              version: 1,
              attempt: 0,
              complete: false,
              results: [],
            },
          });
          await prepareReclassification(
            tx,
            continuationRunId,
            candidates,
            authorization,
          );
        }
        await getDb(tx)
          .insert(runOperation)
          .values({
            runId: source.id,
            operationId: OPERATION,
            kind: "reclassification_recovery",
            inputFingerprint: await sha256Hex(JSON.stringify(source.input)),
            state: "completed",
            completedAt: new Date(),
            result: z.json().parse({
              continuationRunId,
              reconciled: input.emails.length,
              selected: candidates.length,
            }),
          });
      });
    }
    if (sources.length < 25) return;
    cursor = sources[sources.length - 1];
  }
}
