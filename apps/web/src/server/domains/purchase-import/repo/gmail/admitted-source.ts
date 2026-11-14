import type { EmailExecutionPolicy } from "@cubby/schemas/email-fields";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { email as emailTable, ledgerParty, run } from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
  type EmailEvidenceWriteScope,
} from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";

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

export function emailPublicationChanged(
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

type GmailPublicationContext = {
  scope: EmailEvidenceWriteScope;
  recordObservation: (id: string | null) => void;
};

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
    removed?: boolean;
  },
  publish: (
    tx: Database,
    current: typeof emailTable.$inferSelect | null,
    publication: GmailPublicationContext,
  ) => Promise<T>,
  scope?: EmailEvidenceWriteScope,
): Promise<T | null> {
  const initialObservationId = input.observationId ?? null;
  const commitEvidence = async (
    tx: DrizzleTransaction,
    scope: EmailEvidenceWriteScope,
  ) => {
    assertEmailEvidenceScope(databaseForTransaction(tx), scope);
    // Transaction-local: a contended member lock fails fast and frees the socket.
    await tx.execute(sql`SELECT set_config('lock_timeout', '2000', true)`);
    let observationId = initialObservationId;
    const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
    // Shared: removal, admission and correction lock the owner exclusively and
    // win, while unrelated Emails publish concurrently.
    const [party] = await tx
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(and(eq(ledgerParty.id, partyId), notDeleted(ledgerParty)))
      .for("share");
    const runIds = [
      ...new Set(
        [input.runId, input.expected?.runId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ].map((id) => runEntityId.parse(id));
    // Requester and captured Runs lock in one sorted statement. Publication
    // may update a captured Run, so neither holds it shared.
    if (runIds.length)
      await tx
        .select({ id: run.id })
        .from(run)
        .where(inArray(run.id, runIds))
        .orderBy(asc(run.id))
        .for("no key update");
    if (input.runId)
      await (
        await import("~/server/domains/run/repo/execution-context")
      ).assertRunExecutable(
        databaseForTransaction(tx),
        runEntityId.parse(input.runId),
      );
    const decline = async (
      reason: "removed" | "frozen" | "changed",
      _current: typeof emailTable.$inferSelect | null,
    ) => {
      if (input.recordHandlingReceipt !== false)
        await (
          await import("~/server/domains/email/repo/discovery-email-audit")
        ).recordDiscoveryEmailReceipt(databaseForTransaction(tx), {
          ...input,
          observationId,
          outcome: reason,
        });
      if (input.runId && input.expected) {
        const [owner] = await tx
          .select({ purpose: run.purpose })
          .from(run)
          .where(eq(run.id, runEntityId.parse(input.runId)));
        if (owner?.purpose === "mail_reclassify")
          await (
            await import("~/server/domains/purchase-import/repo/gmail/reclassification-receipt")
          ).saveReclassificationReceipt(
            databaseForTransaction(tx),
            input.runId,
            input.expected,
            {
              result: {
                id: (
                  await import("@cubby/schemas/identifiers")
                ).parseShortcodeFor("email", input.expected.shortcode),
                outcome: reason,
                classification: null,
                stage: null,
                conflict: false,
                error: null,
              },
              observationId,
              sourceChecksum: input.expected.checksum,
            },
          );
      }
      return null;
    };
    if (!party) return decline("removed", null);
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
    const result = await publish(txDb, current ?? null, {
      scope,
      recordObservation: (id) => {
        observationId = id;
      },
    });
    if (input.recordHandlingReceipt !== false)
      await (
        await import("~/server/domains/email/repo/discovery-email-audit")
      ).recordDiscoveryEmailReceipt(txDb, {
        ...input,
        observationId,
        outcome: input.removed ? "removed" : undefined,
      });
    if (input.runId && input.expected) {
      const [owner] = await tx
        .select({ purpose: run.purpose })
        .from(run)
        .where(eq(run.id, runEntityId.parse(input.runId)));
      if (owner?.purpose === "mail_reclassify") {
        const { reclassificationReceipt, saveReclassificationReceipt } =
          await import("~/server/domains/purchase-import/repo/gmail/reclassification-receipt");
        await saveReclassificationReceipt(
          txDb,
          input.runId,
          input.expected,
          await reclassificationReceipt(
            txDb,
            input.expected,
            observationId,
            result,
            input.removed,
          ),
        );
      }
    }
    return result;
  };
  if (scope !== undefined) {
    // An existing owner must prove its gate; never acquire one after its locks.
    assertEmailEvidenceScope(db, scope);
    return withTransaction(db, (tx) => commitEvidence(tx, scope));
  }
  return withEmailEvidenceWrite(db, (transactionDb, ownedScope) =>
    withTransaction(transactionDb, (tx) => commitEvidence(tx, ownedScope)),
  );
}
