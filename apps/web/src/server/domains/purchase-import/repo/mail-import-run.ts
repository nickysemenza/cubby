import { assessmentFamily, feedbackAuthority } from "@cubby/schemas/assessment";
import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
/**
 * Mail import admission: classified Emails become one Pi Run's targets. The
 * Run freezes each Email's checksum and owns it through `Email.runId`,
 * so discovery replay and a member's import of the same Email converge on one
 * owner. Interpretation (Vendor, orders, Products) happens later, through the
 * public tools (ADR 0010).
 */
import {
  emailId,
  userId,
  parseEntityId,
  runEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  mailboxDiscoveryInput,
  MAILBOX_RESEARCH_VERSION,
} from "@cubby/schemas/mailbox-research";
import {
  runTargetOutcomeReceipt,
  runStatus,
  runTrigger,
  mailResearchRunInput,
} from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { senderAddress } from "~/lib/vendor/domains";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  databaseForTransaction,
  notDeleted,
  withTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  ledgerParty,
  email as emailTable,
  orderMail,
  run,
} from "~/server/db/schema";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import {
  findControlledMailImport,
  CONTROLLED_MAIL_SOURCE_STATUSES,
} from "~/server/domains/purchase-import/repo/controlled-mail-import";
import { withEmailEvidenceWrite } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import {
  emailHasProtectingIntentSql,
  readEmailProtectingIntent,
} from "~/server/domains/purchase-import/repo/email-review-intent";
import { mailImportEnabled } from "~/server/domains/purchase-import/repo/mail-import-settings";
import {
  transferMailRunSources,
  mailSourceTransferReceipt,
  MAIL_SOURCE_TRANSFER_OPERATION,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import {
  assertMailSourceIdentityReady,
  HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
} from "~/server/domains/purchase-import/repo/mail-source-identity";
import { readSenderAttributions } from "~/server/domains/purchase-import/repo/sender-attribution-read";
import {
  actorSnapshot,
  assertRunParent,
} from "~/server/domains/run/repo/ensure-run";
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { recordChange } from "~/server/generic/changes/repo/change";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { hasLiveRunJobLease } from "~/server/generic/jobs/repo/job-reads";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { dispatchStartedRun } from "./dispatch";

const CLASSIFICATION_RUN_PURPOSES: (typeof run.$inferSelect.purpose)[] = [
  "mail_discovery",
  "mail_reclassify",
  "ai_refresh",
];

type MailImportAdmission = {
  ledgerPartyId: string;
  userId: string;
  /** Acquisition may constrain a mailbox; each Email keeps its own. */
  mailboxId?: string;
  /** Retained OrderMail UUIDs, not Gmail message ids. */
  messageIds: readonly string[];
  expectedChecksums?: readonly { orderMailId: string; checksum: string }[];
  parentRunId?: RunId;
  automatic?: boolean;
  /** A newly verified identity can revisit an untouched automatic unresolved outcome once. */
  senderRecheck?: { sender: string; vendorId: string };
};

async function lockMailSources(
  tx: DrizzleTransaction,
  input: MailImportAdmission,
  partyId: NonNullable<typeof run.$inferSelect.ledgerPartyId>,
) {
  const sources = await readRetainedMail(
    tx,
    {
      ledgerPartyIds: [partyId],
      mailboxId: input.mailboxId,
      orderMailIds: input.messageIds,
    },
    "update",
  );
  if (sources.length !== input.messageIds.length)
    throw new Error("Mail source was not found for this member and mailbox.");
  for (const expected of input.expectedChecksums ?? [])
    if (
      sources.find((source) => source.id === expected.orderMailId)
        ?.rawChecksum !== expected.checksum
    )
      throw new Error(
        "Mail source evidence changed; refresh before importing.",
      );
  for (const source of sources) await assertMailSourceIdentityReady(tx, source);
  return sources;
}

const senderRecheckRevision = (identity: {
  sender: string;
  vendorId: string;
}) => sha256Hex(JSON.stringify([identity.sender, identity.vendorId]));

/** A later member edit/review, changed bytes, or newer outcome prevents unattended reopening. */
const untouchedAutomaticUnresolved = () => sql`EXISTS (
  SELECT 1 FROM "RunOperation" outcome
  WHERE outcome."runId" = ${run.id}
    AND outcome.kind = ${"target_outcome"} AND outcome.state = ${runStatus.enum.completed}
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityKind' = ${"email"}
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityId' = ${emailTable.id}::text
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'state' = ${"unresolved"}
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'targetFingerprint' = ${emailTable.checksum}
    AND outcome."completedAt" >= ${emailTable.updatedAt}
    AND NOT EXISTS (SELECT 1 FROM "RunOperation" newer
      WHERE newer."runId" = outcome."runId" AND newer.kind = outcome.kind
        AND newer.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityId' = ${emailTable.id}::text
        AND newer."completedAt" > outcome."completedAt")
) AND NOT EXISTS (
  SELECT 1 FROM "Feedback" reviewed JOIN "AssessmentState" state ON state.id = reviewed."assessmentId"
  WHERE state.family = ${assessmentFamily.enum.mail_import_outcome}
    AND state."recordId" = ${emailTable.id} AND reviewed.authority = ${feedbackAuthority.enum.member}
) AND NOT ${emailHasProtectingIntentSql(sql`${emailTable.id}`, sql`${emailTable.orderMailId}`)}`;

/** Frozen inputs retain attempted source/mapping pairs even after ownership moves. */
// includes-deleted: disposed Run inputs still prove that this source/mapping was attempted.
const unattemptedSenderMapping = (revision: SQL) => sql`NOT EXISTS (
 SELECT 1 FROM "Run" attempted, jsonb_array_elements(coalesce(attempted.input->'sources', '[]'::jsonb)) source
 WHERE attempted."ledgerPartyId" = ${emailTable.ledgerPartyId}
 AND attempted."clientKey" LIKE ('%sender-proof:' || ${revision} || ':%')
 AND source->>'orderMailId' = ${emailTable.orderMailId}::text
 AND source->>'checksum' = ${emailTable.checksum}
)`;

/**
 * Emails another live Mail import Run already owns stay with it; the rest
 * are fresh. An excluded, deleted or changed Email is refused.
 */
async function partitionOwnership(
  tx: DrizzleTransaction,
  partyId: NonNullable<typeof run.$inferSelect.ledgerPartyId>,
  sources: RetainedMail[],
  controlledParentRunId?: RunId,
  senderRevision?: string,
) {
  const messages = await tx
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, partyId),
        or(
          ...sources.map((source) =>
            and(
              eq(emailTable.mailboxId, source.mailboxId),
              eq(emailTable.messageId, source.messageId),
            ),
          ),
        ),
      ),
    )
    .for("update");
  const owners = new Map<string, typeof run.$inferSelect>();
  const fresh: RetainedMail[] = [];
  const transfers = new Map<RunId, RetainedMail[]>();
  for (const source of sources) {
    const message = messages.find(
      (candidate) =>
        candidate.mailboxId === source.mailboxId &&
        candidate.messageId === source.messageId,
    );
    if (
      controlledParentRunId &&
      message &&
      !CONTROLLED_MAIL_SOURCE_STATUSES.some(
        (status) => status === message.status,
      )
    )
      continue;
    if (message && ["excluded", "deleted"].includes(message.status))
      throw new Error(
        "Mail source was excluded or deleted from the connected mailbox.",
      );
    if (
      message &&
      (message.orderMailId !== source.id ||
        message.checksum !== source.rawChecksum)
    )
      throw new Error("Mail import ledger differs from its retained original.");
    const [owner] = message?.runId
      ? await tx
          .select()
          .from(run)
          .where(
            and(
              eq(run.id, runEntityId.parse(message.runId)),
              eq(run.ledgerPartyId, partyId),
              notDeleted(run),
            ),
          )
          .limit(1)
      : [];
    if (
      owner &&
      !owner.retiredAt &&
      !CLASSIFICATION_RUN_PURPOSES.includes(owner.purpose)
    ) {
      if (
        senderRevision &&
        owner.purpose === "mail_import" &&
        owner.trigger === "discovery" &&
        (owner.status === "completed" || owner.status === "needs_review") &&
        message?.status === "blocked" &&
        !owner.clientKey?.includes(`sender-proof:${senderRevision}:`)
      ) {
        const [eligible] = await tx
          .select({ id: emailTable.id })
          .from(emailTable)
          .innerJoin(run, eq(run.id, emailTable.runId))
          .where(
            and(
              eq(emailTable.id, message.id),
              untouchedAutomaticUnresolved(),
              unattemptedSenderMapping(sql`${senderRevision}`),
            ),
          );
        const intent = await readEmailProtectingIntent(
          databaseForTransaction(tx),
          emailId.parse(message.id),
        );
        if (
          eligible &&
          intent.status === "captured" &&
          intent.feedbackIds.length === 0 &&
          !(await hasLiveRunJobLease(tx, owner.id, "purchase.dispatch"))
        ) {
          transfers.set(owner.id, [...(transfers.get(owner.id) ?? []), source]);
          continue;
        }
      }
      const transferable =
        controlledParentRunId &&
        owner.purpose === "mail_import" &&
        owner.trigger === "discovery" &&
        owner.status === "running" &&
        owner.parentRunId !== controlledParentRunId &&
        !owner.coordinatorStartedAt &&
        message?.status === "researching";
      if (transferable) {
        // A dispatch accepted before the mailbox pause may not have written
        // coordinatorStartedAt yet. Its live Job must finish before transfer.
        if (await hasLiveRunJobLease(tx, owner.id, "purchase.dispatch"))
          throw new JobDeferredError(
            "Waiting for the queued Mail import's dispatch to finish before transferring its selected sources",
            new Date(Date.now() + 15_000),
            "provider_capacity",
          );
        transfers.set(owner.id, [...(transfers.get(owner.id) ?? []), source]);
      } else owners.set(owner.id, owner);
    } else fresh.push(source);
  }
  return { owners, fresh, transfers };
}

export async function admitMailImport(
  db: Database,
  input: MailImportAdmission,
) {
  if (input.messageIds.length === 0) return [];
  if (
    input.messageIds.length > 50 ||
    new Set(input.messageIds).size !== input.messageIds.length
  )
    throw new Error("Choose at most fifty distinct retained mail sources.");
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const actorId = userId.parse(input.userId);
  const selectedSources = new Set(
    input.expectedChecksums?.map((source) => source.orderMailId),
  );
  const memberSelected =
    !input.parentRunId &&
    input.messageIds.every((id) => selectedSources.has(id));
  const admit = (writeDb: Database) =>
    withTransaction(writeDb, async (tx) => {
      const [parent] = input.parentRunId
        ? await tx
            .select({
              purpose: run.purpose,
              input: run.input,
              vendorId: run.vendorId,
            })
            .from(run)
            .where(eq(run.id, input.parentRunId))
        : [];
      const parentPolicy = mailboxDiscoveryInput.safeParse(parent?.input);
      const discoveryParent =
        parent?.purpose === "mail_discovery" && parentPolicy.success
          ? parentPolicy.data
          : null;
      const controlled = discoveryParent?.controlled;
      const [party] = await tx
        .select()
        .from(ledgerParty)
        .where(
          and(
            eq(ledgerParty.id, partyId),
            eq(ledgerParty.userId, actorId),
            eq(ledgerParty.kind, "member"),
            notDeleted(ledgerParty),
          ),
        )
        // Serialize admission while allowing source claims to reference this member.
        .for("no key update");
      if (!party) throw new Error("Mail import requires the owning member.");
      // Serialize the switch with automatic admission; already admitted Runs keep their controls.
      if (
        input.automatic &&
        !controlled &&
        (!input.mailboxId ||
          !(await mailImportEnabled(tx, input.mailboxId, true)) ||
          Boolean(
            await findControlledMailImport(
              databaseForTransaction(tx),
              input.mailboxId,
            ),
          ))
      )
        return [];
      if (input.parentRunId)
        await assertRunParent(tx, input.parentRunId, {
          actorUserId: actorId,
          ledgerPartyId: partyId,
        });
      if (input.parentRunId) {
        if (
          parent?.purpose === "mail_discovery" &&
          (!parentPolicy.success ||
            parentPolicy.data.executionPolicy === "classification_only")
        )
          throw new Error(
            "Classification-only discovery cannot admit Emails to Pi.",
          );
      }
      const selected = await lockMailSources(tx, input, partyId);
      if (
        controlled &&
        (!parent?.vendorId ||
          selected.some(
            (source) => source.mailboxId !== discoveryParent.mailboxId,
          ))
      )
        throw new Error(
          "A controlled import admits only its selected Vendor's mailbox sources.",
        );
      const sources = controlled
        ? selected.filter(
            (source) =>
              !source.vendorId || source.vendorId === parent?.vendorId,
          )
        : selected;
      if (!sources.length) return [];
      const senderRevision = input.senderRecheck
        ? await senderRecheckRevision(input.senderRecheck)
        : undefined;
      if (input.senderRecheck) {
        const [identity] = await readSenderAttributions(tx, [
          input.senderRecheck.sender,
        ]);
        if (
          identity?.vendorId !== input.senderRecheck.vendorId ||
          sources.some(
            (source) =>
              senderAddress(source.sender) !== input.senderRecheck?.sender,
          )
        )
          return [];
      }
      const { owners, fresh, transfers } = await partitionOwnership(
        tx,
        partyId,
        sources,
        controlled ? input.parentRunId : undefined,
        senderRevision,
      );
      const existing = [...owners.values()].map((row) => ({
        created: false,
        row,
      }));
      const start = async (
        admittedSources: RetainedMail[],
        transferFrom?: RunId,
      ) => {
        const sourceSet = mailResearchRunInput.parse({
          kind: "mail_research",
          sources: admittedSources.map((source) => ({
            orderMailId: source.id,
            checksum: source.rawChecksum,
          })),
        });
        const clientKey = `mail-research:${party.id}:${senderRevision ? `sender-proof:${senderRevision}:` : ""}${controlled ? `controlled:${input.parentRunId}:` : ""}${await sha256Hex(
          JSON.stringify([MAILBOX_RESEARCH_VERSION, sourceSet]),
        )}`;
        const [replayed] = await tx
          .select()
          .from(run)
          .where(eq(run.clientKey, clientKey))
          .limit(1);
        if (replayed) return { created: false, row: replayed };
        const snapshot = await actorSnapshot(tx, actorId);
        const id = runEntityId.parse(crypto.randomUUID());
        const row = await insertWithShortcode(tx, "run", {
          id,
          ledgerPartyId: party.id,
          purpose: "mail_import",
          trigger: memberSelected ? "foreground" : "discovery",
          status: "running",
          channel: "system",
          actorUserId: actorId,
          actorName: snapshot.actorName,
          actorEmail: snapshot.actorEmail,
          actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
          actorLedgerPartyName: snapshot.ledgerPartyName,
          actorLedgerPartyKind: snapshot.ledgerPartyKind,
          parentRunId: input.parentRunId ?? null,
          vendorId: controlled ? (parent?.vendorId ?? null) : null,
          cause: memberSelected ? "member_request" : "source_discovered",
          coordinatorModel: coordinatorModelFor("mail_import"),
          input: sourceSet,
          clientKey,
          startedAt: new Date(),
          dispatchEventId: crypto.randomUUID(),
          agentSessionId: importRunAgentIdentity(id, "mail_import"),
        });
        if (transferFrom) {
          // transferMailRunSources preserves the old frozen roster and outcomes;
          // each successor names just this owner's selected, still-held sources.
          await transferMailRunSources(
            tx,
            transferFrom,
            id,
            admittedSources.map((source) => source.id),
          );
          const receipt = mailSourceTransferReceipt.parse({
            toRunId: id,
            sources: sourceSet.sources,
          });
          await insertOperation(tx, {
            runId: transferFrom,
            operationId: `${senderRevision ? "sender-transfer" : "controlled-transfer"}:${id}`,
            kind: MAIL_SOURCE_TRANSFER_OPERATION,
            inputFingerprint: await sha256Hex(JSON.stringify(receipt)),
            state: "completed",
            result: receipt,
          });
        } else {
          const assigned = await tx
            .update(emailTable)
            .set({ status: "researching", runId: id })
            .where(
              or(
                ...admittedSources.map((source) =>
                  and(
                    eq(emailTable.ledgerPartyId, source.ledgerPartyId),
                    eq(emailTable.mailboxId, source.mailboxId),
                    eq(emailTable.messageId, source.messageId),
                    eq(emailTable.orderMailId, source.id),
                    eq(emailTable.checksum, source.rawChecksum),
                  ),
                ),
              ),
            )
            .returning({ orderMailId: emailTable.orderMailId });
          if (assigned.length !== admittedSources.length)
            throw new Error("Mail source ownership assignment is incomplete.");
        }
        await recordChange(tx, { kind: "source", categories: ["email"] });
        await dispatchStartedRun(tx, {
          id: row.id,
          eventId: row.dispatchEventId!,
          purpose: row.purpose,
        });
        return { created: true, row };
      };
      const admitted = [...existing];
      if (fresh.length) admitted.push(await start(fresh));
      for (const [fromRunId, transferred] of transfers)
        admitted.push(await start(transferred, fromRunId));
      return admitted;
    });
  return input.senderRecheck
    ? withEmailEvidenceWrite(db, (writeDb) => admit(writeDb))
    : admit(db);
}

/** Admission and its dispatch intent commit together. */
export async function startMailImport(
  db: Database,
  input: MailImportAdmission,
) {
  return (await admitMailImport(db, input)).map(({ row }) => ({
    runId: row.id,
    status: row.status,
  }));
}

/** Revisit retained related Emails that predate automatic import admission. */
export async function importPendingEmails(db: Database) {
  const { listMemberMailboxes } =
    await import("~/server/domains/purchase-import/repo/gmail/targets");
  const { mailImportEnabled } =
    await import("~/server/domains/purchase-import/repo/mail-import-settings");
  const { retainedEmailImportContentCondition } =
    await import("~/server/domains/purchase-import/repo/email-content");
  const identities = (await readSenderAttributions(db)).filter(
    (row) => row.state === "verified" && row.vendorId !== null,
  );
  const recheckIdentities = await Promise.all(
    identities.map(async (row) => ({
      sender: row.sender,
      vendorId: row.vendorId,
      revision: await senderRecheckRevision({
        sender: row.sender,
        vendorId: row.vendorId ?? "",
      }),
    })),
  );
  const errors: unknown[] = [];
  for (const target of await listMemberMailboxes(db)) {
    const actorId = target.userId;
    if (!actorId) continue;
    if (!(await mailImportEnabled(db, target.mailboxId))) continue;
    const pending = await getDb(db)
      .select({ id: orderMail.id })
      .from(emailTable)
      .innerJoin(
        orderMail,
        and(
          eq(orderMail.id, emailTable.orderMailId),
          eq(orderMail.rawChecksum, emailTable.checksum),
        ),
      )
      .leftJoin(run, eq(run.id, emailTable.runId))
      .where(
        and(
          eq(
            emailTable.ledgerPartyId,
            parseEntityId("ledgerParty", target.ledgerPartyId),
          ),
          eq(emailTable.mailboxId, target.mailboxId),
          eq(emailTable.classification, "related"),
          or(
            isNull(emailTable.classificationVersion),
            ne(
              emailTable.classificationVersion,
              HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
            ),
          ),
          retainedEmailImportContentCondition(),
          or(
            isNull(emailTable.runId),
            and(
              inArray(run.purpose, CLASSIFICATION_RUN_PURPOSES),
              eq(run.ledgerPartyId, emailTable.ledgerPartyId),
            ),
          ),
          notInArray(emailTable.status, ["excluded", "deleted"]),
          notDeleted(emailTable),
        ),
      )
      .orderBy(asc(emailTable.createdAt), asc(emailTable.id))
      .limit(50);
    const admit = (messageIds: readonly string[]) =>
      withTransactionDatabase(db, async (tx) => {
        const admitted = await startMailImport(tx, {
          ledgerPartyId: target.ledgerPartyId,
          userId: actorId,
          mailboxId: target.mailboxId,
          automatic: true,
          messageIds,
        });
        // Claiming a full page and its continuation are one durable commit.
        // A switch-off race admits nothing and must not spin another pass.
        if (messageIds.length === 50 && admitted.length > 0)
          await (
            await import("~/server/workflows/background-tasks/publish")
          ).publishBackgroundTasks(
            tx,
            [
              {
                kind: "maintenance.purchase-discovery",
                requestedAt: new Date().toISOString(),
              },
            ],
            { source: "mail-import-backlog" },
          );
        return admitted;
      });
    try {
      await admit(pending.map(({ id }) => id));
    } catch {
      // SILENT: retry each source below; persistent errors are returned and reported after discovery.
      // A source may change after selection. Isolate it without abandoning
      // other sources; admission replay preserves ownership on a retry.
      for (const { id } of pending) {
        try {
          await admit([id]);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (recheckIdentities.length > 0) {
      const candidates = await getDb(db)
        .select({
          id: orderMail.id,
          ownerId: run.id,
          sender: sql<string>`sender_identity.sender`,
          vendorId: sql<string>`sender_identity."vendorId"`,
          revision: sql<string>`sender_identity.revision`,
        })
        .from(emailTable)
        .innerJoin(
          orderMail,
          and(
            eq(orderMail.id, emailTable.orderMailId),
            eq(orderMail.rawChecksum, emailTable.checksum),
          ),
        )
        .innerJoin(run, eq(run.id, emailTable.runId))
        .innerJoin(
          sql`jsonb_to_recordset(${JSON.stringify(recheckIdentities)}::jsonb) AS sender_identity(sender text, "vendorId" text, revision text)`,
          sql`lower(trim(coalesce(substring(${emailTable.sender} from '<([^>]+)>'), ${emailTable.sender}))) = sender_identity.sender`,
        )
        .where(
          and(
            eq(
              emailTable.ledgerPartyId,
              parseEntityId("ledgerParty", target.ledgerPartyId),
            ),
            eq(emailTable.mailboxId, target.mailboxId),
            eq(emailTable.status, "blocked"),
            eq(emailTable.classification, "related"),
            or(
              isNull(emailTable.classificationVersion),
              ne(
                emailTable.classificationVersion,
                HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
              ),
            ),
            eq(run.purpose, "mail_import"),
            eq(run.trigger, runTrigger.enum.discovery),
            inArray(run.status, [
              runStatus.enum.completed,
              runStatus.enum.needs_review,
            ]),
            isNull(run.retiredAt),
            notDeleted(run),
            notDeleted(emailTable),
            retainedEmailImportContentCondition(),
            sql`coalesce(${run.clientKey}, '') NOT LIKE ('%sender-proof:' || sender_identity.revision || ':%')`,
            untouchedAutomaticUnresolved(),
            unattemptedSenderMapping(sql`sender_identity.revision`),
            sql`NOT EXISTS (SELECT 1 FROM (${emailPurchaseEvidenceSql()}) evidence WHERE evidence.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked}))`,
          ),
        )
        .orderBy(asc(emailTable.createdAt), asc(emailTable.id))
        .limit(50);
      const groups = new Map<string, typeof candidates>();
      for (const row of candidates)
        groups.set(row.revision, [...(groups.get(row.revision) ?? []), row]);
      let admitted = 0;
      for (const group of groups.values()) {
        const identity = group[0];
        if (!identity) continue;
        try {
          admitted += (
            await admitMailImport(db, {
              ledgerPartyId: target.ledgerPartyId,
              userId: actorId,
              mailboxId: target.mailboxId,
              automatic: true,
              messageIds: group.map((row) => row.id),
              senderRecheck: {
                sender: identity.sender,
                vendorId: identity.vendorId,
              },
            })
          ).filter((started) => started.created).length;
        } catch (error) {
          errors.push(error);
        }
      }
      if (candidates.length === 50 && admitted > 0)
        await (
          await import("~/server/workflows/background-tasks/publish")
        ).publishBackgroundTasks(
          db,
          [
            {
              kind: "maintenance.purchase-discovery",
              requestedAt: new Date().toISOString(),
            },
          ],
          { source: "sender-attribution-backlog" },
        );
    }
  }
  return { errors };
}
