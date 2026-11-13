import { emailReclassifyResult } from "@cubby/schemas/email-actions";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";

import type { Database } from "~/server/db";
import { readReclassificationReceipts } from "~/server/domains/purchase-import/repo/gmail/reclassification-receipt";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import type { RunRow } from "~/server/domains/run/repo/ai-work-state";

import { deferClassificationRefresh } from "../../repo/gmail/admitted-source";
import { gmailProviderForUser } from "../../repo/gmail/provider";
import { readReclassifiedEmail } from "../../repo/gmail/reclassification-work";
import { ingestGmailMessages } from "./ingest";

export type ReclassificationPorts = Pick<
  Parameters<typeof ingestGmailMessages>[2],
  "triage" | "relevance" | "candidateChoice" | "storage"
>;

/** The Run claim fences execution; publication rechecks the captured Email evidence. */
export async function executeReclassificationTarget(
  db: Database,
  owner: RunRow,
  target: ReturnType<typeof mailReclassifyRunInput.parse>["emails"][number],
  ports: ReclassificationPorts = {},
) {
  const input = mailReclassifyRunInput.parse(owner.input);
  const current = await readReclassifiedEmail(db, target.emailId);
  const result = (outcome: string, after = current) =>
    emailReclassifyResult.parse({
      id: current?.shortcode ?? target.emailId,
      outcome,
      classification: after?.classification ?? null,
      stage: after?.classificationStage ?? null,
      conflict: false,
      error: null,
    });
  if (!current || current.deletedAt) return result("removed");
  if (
    current.ledgerPartyId !== owner.ledgerPartyId ||
    current.mailboxId !== input.mailboxId
  )
    throw new Error(
      "Reclassification Email is outside its member/mailbox roster",
    );
  if (current.checksum !== target.checksum) return result("changed");
  if (
    current.classificationVersion === HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION ||
    (await deferClassificationRefresh(db, "classification_only", current))
  )
    return result("frozen");
  const provider = await gmailProviderForUser(
    db,
    owner.actorUserId,
    input.mailboxId,
  );
  await ingestGmailMessages(db, provider, {
    ...ports,
    triage:
      ports.triage ??
      (await import("./triage-model")).productionMailTriage(db, owner.id),
    ledgerPartyId: current.ledgerPartyId,
    mailboxId: input.mailboxId,
    messageIds: [current.messageId],
    runId: owner.id,
    reclassify: true,
  });
  const published = (await readReclassificationReceipts(db, owner.id)).find(
    (row) =>
      row.key ===
      `${owner.id}:reclassification:${current.id}:${target.checksum}`,
  );
  if (published) return published.result;
  const after = await readReclassifiedEmail(db, current.id);
  if (!after || after.deletedAt || after.status === "deleted")
    return result("removed", after);
  if (after.checksum !== target.checksum) return result("changed", after);
  return result(
    after.classification === current.classification ? "confirmed" : "replaced",
    after,
  );
}
