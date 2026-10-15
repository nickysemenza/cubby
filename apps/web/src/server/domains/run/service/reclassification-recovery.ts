import { buildActorContext } from "@cubby/schemas/context";
import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";

import type { Database } from "~/server/db";
import { deferClassificationRefresh } from "~/server/domains/purchase-import/repo/gmail/admitted-source";
import { prepareReclassification } from "~/server/domains/purchase-import/repo/gmail/reclassification-work";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { mailboxApproval } from "~/server/domains/purchase-import/service/gmail/reclassify";

import { ensureRun } from "../repo/ensure-run";
import { assertExecutionAuthorization } from "../repo/execution-authorization";
import { executionRequestForRun } from "../repo/execution-context";
import {
  hasLaterReclassifyEvaluation,
  laterLegacyReclassifyRuns,
  liveEmailsById,
  lockRunAndCheckRecovery,
  recordReclassificationRecovery,
  unrecoveredReclassificationRuns,
  type RecoveryCursor,
  type RecoveryEmail,
} from "../repo/reclassification-recovery-state";
import { withRunTransaction } from "../repo/run-transaction";

const fulfilled = new Set([
  "replaced",
  "confirmed",
  "awaiting_acceptance",
  "resolution_kept",
]);

/** One-shot reconciliation records its decision separately from immutable old Run receipts. */
export async function recoverHistoricalReclassification(db: Database) {
  let cursor: RecoveryCursor | undefined;
  for (;;) {
    const sources = await unrecoveredReclassificationRuns(db, cursor, 25);
    for (const source of sources) {
      const parsed = mailReclassifyRunInput.safeParse(source.input);
      if (!parsed.success) continue;
      const input = parsed.data;
      const checkpoint = mailReclassificationCheckpoint.safeParse(
        source.progress,
      );
      const originals = await liveEmailsById(
        db,
        input.emails.map((item) => item.emailId),
      );
      const candidates: RecoveryEmail[] = [];
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
        if (await hasLaterReclassifyEvaluation(db, item, source.createdAt))
          continue;
        const laterLegacy = await laterLegacyReclassifyRuns(
          db,
          item.ledgerPartyId,
          source.createdAt,
        );
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
      await withRunTransaction(db, async (tx) => {
        if (await lockRunAndCheckRecovery(tx, source.id)) return;
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
        await recordReclassificationRecovery(
          tx,
          source.id,
          await sha256Hex(JSON.stringify(source.input)),
          {
            continuationRunId,
            reconciled: input.emails.length,
            selected: candidates.length,
          },
        );
      });
    }
    if (sources.length < 25) return;
    cursor = sources[sources.length - 1];
  }
}
