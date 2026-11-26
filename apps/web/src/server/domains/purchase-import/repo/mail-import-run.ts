import { systemActor } from "@cubby/schemas/context";
import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import { MAIL_IMPORT_GAP_EXECUTOR } from "@cubby/schemas/email-fields";
/**
 * Mail import admission: classified Emails become one Pi Run's targets. The
 * Run freezes each Email's checksum and owns it through `Email.runId`,
 * so discovery replay and a member's import of the same Email converge on one
 * owner. Interpretation (Vendor, orders, Products) happens later, through the
 * public tools (ADR 0010).
 */
import {
  type LedgerPartyId,
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
import { agentFailureCode } from "@cubby/schemas/purchase-agent-services";
import {
  runTargetOutcomeReceipt,
  runPurpose,
  runStatus,
  mailResearchRunInput,
  MAIL_IMPORT_SKILL_REVISION,
} from "@cubby/schemas/run-fields";
import { suggestionFamily, feedbackAuthority } from "@cubby/schemas/suggestion";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lte,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { senderAddress } from "~/lib/vendor/domains";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  ledgerParty,
  purchase,
  vendor,
  vendorAccount,
  email as emailTable,
  orderMail,
  run,
  runOperation,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { emailReviewsForEmailSql } from "~/server/domains/email/repo/email-decision-sql";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import {
  acceptedOrdersBoundTo,
  acceptedOrdersBoundToSql,
} from "~/server/domains/purchase-import/repo/accepted-order-read";
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
import { emitEmailRunAssignment } from "~/server/domains/purchase-import/repo/mail-run-kernel";
import {
  countImportAttempt,
  importAttemptsExhausted,
  importAttemptsExhaustedSql,
  transferMailRunSources,
  mailSourceTransferReceipt,
  MAIL_SOURCE_TRANSFER_OPERATION,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import {
  assertMailSourceIdentityReady,
  HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
} from "~/server/domains/purchase-import/repo/mail-source-identity";
import { matchingOrderIdSql } from "~/server/domains/purchase-import/repo/order-identity-sql";
import { learnAcceptedSenders } from "~/server/domains/purchase-import/repo/sender-attribution";
import { readSenderAttributions } from "~/server/domains/purchase-import/repo/sender-attribution-read";
import { dispatchStartedRun } from "~/server/domains/run/repo/coordinator-dispatch";
import {
  actorSnapshot,
  assertRunParent,
} from "~/server/domains/run/repo/ensure-run";
import { hasLiveRunPassClaim } from "~/server/domains/run/repo/run-execution";
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { findPgError } from "~/server/errors/db-errors";
import { recordChange } from "~/server/generic/changes/repo/change";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  checkPassPageTime,
  limitPassPageTransaction,
  PassPageBudgetError,
  rethrowPassPageControl,
  withPassPageTransaction,
  type Claim,
  type PassPageTransaction,
} from "~/server/kernel/api";
import { WorkDeferredError } from "~/server/kernel/work-errors";

import { mailReadContent } from "./gmail/read-content";
import {
  readEmailMailKeys,
  readEmailMailKeysForMails,
  readMailRuleCandidates,
} from "./mail-rule-evidence";
import { normalizeOrderKey, vendorOrderIdsSql } from "./order-identity";

const CLASSIFICATION_RUN_PURPOSES: (typeof run.$inferSelect.purpose)[] = [
  "mail_discovery",
  "mail_reclassify",
  "ai_refresh",
];

/** A member's own stop (`controlRun` cancel or abort), not a Run failure. */
const MEMBER_STOP_FAILURE_CODES = ["user_cancelled", "dispatch_aborted"];

/** A holder no coordinator is working: evidence recovery may readmit its Emails. */
const ENDED_MAIL_IMPORT_STATUSES: (typeof run.$inferSelect.status)[] = [
  runStatus.enum.completed,
  runStatus.enum.needs_review,
  runStatus.enum.failed,
  runStatus.enum.dispatch_failed,
];

/** Statuses an ended holder can leave an Email in without settling it. */
const HELD_UNSETTLED_STATUSES: (typeof emailTable.$inferSelect.status)[] = [
  "unsettled",
  "pending",
];

/**
 * An Email its ended holder left unsettled. A held Email reading `pending`
 * counts only when that holder's newest outcome for its current checksum is
 * unresolved; a paused or outcome-free holder keeps its pending Emails.
 */
const heldUnsettledSql = () =>
  sql<boolean>`(${emailTable.status} = ${"unsettled"} OR (${emailTable.status} = ${"pending"} AND EXISTS (${newestUnresolvedOutcome})))`;

/** The Email fields admission decides from; the row lock covers the whole row. */
const lockedMailSourceFields = {
  id: emailTable.id,
  mailboxId: emailTable.mailboxId,
  messageId: emailTable.messageId,
  orderMailId: emailTable.orderMailId,
  checksum: emailTable.checksum,
  status: emailTable.status,
  runId: emailTable.runId,
  importAttempts: emailTable.importAttempts,
};
type LockedMailSource = {
  [
    K in keyof typeof lockedMailSourceFields
  ]: (typeof emailTable.$inferSelect)[K];
};

/**
 * A controlled child skips Emails outside its parent's statuses; an excluded,
 * deleted or changed Email is refused.
 */
function skipsSource(
  message: LockedMailSource | undefined,
  source: RetainedMail,
  controlledParentRunId: RunId | undefined,
) {
  if (!message) return false;
  if (
    controlledParentRunId &&
    !CONTROLLED_MAIL_SOURCE_STATUSES.some((status) => status === message.status)
  )
    return true;
  if (["excluded", "deleted"].includes(message.status))
    throw new Error(
      "Mail source was excluded or deleted from the connected mailbox.",
    );
  if (
    message.orderMailId !== source.id ||
    message.checksum !== source.rawChecksum
  )
    throw new Error("Mail import ledger differs from its retained original.");
  return false;
}

/**
 * An ended Mail import holder that left this Email unsettled works on it no
 * more; a member selecting the Email admits it afresh instead of being handed
 * the ended Run back.
 */
async function endedHolderLeftUnsettled(
  tx: DrizzleTransaction,
  owner: typeof run.$inferSelect | undefined,
  message: LockedMailSource | undefined,
) {
  if (
    !message ||
    owner?.purpose !== "mail_import" ||
    owner.retiredAt ||
    !ENDED_MAIL_IMPORT_STATUSES.includes(owner.status) ||
    !readmissibleHeldStatus(message.status, false)
  )
    return false;
  // Only a holder whose newest outcome left it unresolved is done with it.
  const [held] = await tx
    .select({ id: emailTable.id })
    .from(emailTable)
    .innerJoin(run, eq(run.id, emailTable.runId))
    .where(
      and(
        eq(emailTable.id, message.id),
        eq(run.id, owner.id),
        sql`EXISTS (${newestUnresolvedOutcome})`,
      ),
    )
    .limit(1);
  return Boolean(held) && !(await hasLiveRunPassClaim(tx, owner.id));
}

/** Changed bytes reopen a pending Email; unchanged ones need it still held unsettled. */
const readmissibleHeldStatus = (
  status: typeof emailTable.$inferSelect.status | undefined,
  sourceChanged: boolean,
) =>
  sourceChanged
    ? status === "pending"
    : status !== undefined && HELD_UNSETTLED_STATUSES.includes(status);

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
  senderRecheck?: {
    sender: string;
    vendorId: string;
    purchase?: PurchaseRecheck;
  };
  /** A retained original changed after an automatic unresolved outcome. */
  sourceRecheck?: true;
  /** The source an unresolved outcome waits on settled after that outcome. */
  waitRecheck?: { outcomeId: string; settledAt: Date };
  /** An agent-routed gap was recorded under an older importer revision. */
  capabilityRecheck?: true;
};

type PurchaseRecheck = {
  purchaseId: string;
  orderId: string;
  evidenceFingerprint: string;
};

/** Accepted source revisions, rather than Purchase edits or clock time, reopen a gap. */
async function importedPurchaseRechecks(
  db: Database,
  partyId: LedgerPartyId,
  requested:
    | { purchaseId: string }
    | { orderIds: readonly string[]; vendorIds: readonly string[] },
) {
  if (
    "orderIds" in requested &&
    (!requested.orderIds.length || !requested.vendorIds.length)
  )
    return [];
  const client = getDb(db);
  const requestedPurchases = client
    .select({ id: purchase.id })
    .from(purchase)
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .where(
      and(
        notDeleted(purchase),
        notDeleted(vendor),
        "purchaseId" in requested
          ? eq(purchase.shortcode, requested.purchaseId)
          : and(
              vendorOrderIdsSql(purchase.orderId, requested.orderIds),
              inArray(vendor.shortcode, [...requested.vendorIds]),
            ),
      ),
    );
  const sources = acceptedOrdersBoundTo(
    (id) => sql`${id} IN (${requestedPurchases})`,
  );
  const rows = await client
    .select({
      purchaseId: purchase.shortcode,
      orderId: purchase.orderId,
      vendorId: vendor.shortcode,
      vendorUuid: vendor.id,
      sourceId: sources.id,
      checksum: sources.checksum,
      outputFingerprint: sources.contentFingerprint,
      evidenceAt: sources.createdAt,
    })
    .from(sources)
    .innerJoin(purchase, eq(purchase.id, sources.purchaseId))
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .innerJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, purchase.vendorAccountId),
        eq(vendorAccount.vendorId, purchase.vendorId),
      ),
    )
    .where(
      and(
        eq(vendorAccount.ledgerPartyId, partyId),
        isNotNull(purchase.orderId),
        notDeleted(purchase),
        notDeleted(vendor),
        notDeleted(vendorAccount),
      ),
    )
    .orderBy(asc(sources.id));
  const groups = new Map<string, typeof rows>();
  for (const row of rows)
    groups.set(row.purchaseId, [...(groups.get(row.purchaseId) ?? []), row]);
  return Promise.all(
    [...groups.values()].map(async (sources) => {
      const first = sources[0];
      if (!first?.orderId) return null;
      return {
        purchaseId: first.purchaseId,
        orderId: first.orderId,
        vendorId: first.vendorId,
        vendorUuid: first.vendorUuid,
        evidenceAt: new Date(
          Math.max(...sources.map((source) => source.evidenceAt.getTime())),
        ).toISOString(),
        evidenceFingerprint: await sha256Hex(
          JSON.stringify(
            sources.map(({ sourceId, checksum, outputFingerprint }) => ({
              sourceId,
              checksum,
              outputFingerprint,
            })),
          ),
        ),
      };
    }),
  ).then((values) => values.filter((value) => value !== null));
}

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
  purchase?: PurchaseRecheck;
}) =>
  sha256Hex(
    JSON.stringify(
      identity.purchase
        ? [identity.sender, identity.vendorId, identity.purchase]
        : [identity.sender, identity.vendorId],
    ),
  );

/**
 * A member cancelled the holder. Only the member's retry or restart, or
 * evidence that appeared after the cancel (changed bytes, accepted order
 * evidence newer than its end), readmits its Emails; a sender mapping that
 * already existed is not new.
 */
const memberStoppedHolder = sql`coalesce(${run.failureCode}, '') IN (${sql.join(
  MEMBER_STOP_FAILURE_CODES.map((code) => sql`${code}`),
  sql`, `,
)})`;

/** A page passes its per-row instant as SQL; admission passes a Date. */
const evidenceInstant = (at: Date | SQL) =>
  at instanceof Date ? sql`${at.toISOString()}::timestamp` : at;

const outcomeFreeAttempt = (
  sourceChanged: boolean,
  newEvidenceAt?: Date | SQL,
) =>
  sql`(${run.endedAt} IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "RunOperation" outcome
    WHERE outcome."runId" = ${run.id} AND outcome.kind = ${"target_outcome"}
      AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityId' = ${emailTable.id}::text)
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${run.input}->'sources', '[]'::jsonb)) frozen
    WHERE frozen->>'orderMailId' = ${emailTable.orderMailId}::text
      AND frozen->>'checksum' ${sourceChanged ? sql`<>` : sql`=`} ${emailTable.checksum})
  AND ${newEvidenceAt ? sql`${run.endedAt} < ${evidenceInstant(newEvidenceAt)}` : sql`true`})`;

const unresolvedOutcome = (
  sourceChanged: boolean,
  newEvidenceAt?: Date | SQL,
) =>
  sql`EXISTS (
  SELECT 1 FROM "RunOperation" outcome
  WHERE outcome."runId" = ${run.id}
    AND outcome.kind = ${"target_outcome"} AND outcome.state = ${runStatus.enum.completed}
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityKind' = ${"email"}
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityId' = ${emailTable.id}::text
    AND outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'state' = ${"unresolved"}
    AND ${
      sourceChanged
        ? sql`outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'targetFingerprint' <> ${emailTable.checksum}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${run.input}->'sources', '[]'::jsonb)) frozen
        WHERE frozen->>'orderMailId' = ${emailTable.orderMailId}::text
        AND frozen->>'checksum' = outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'targetFingerprint')`
        : sql`outcome.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'targetFingerprint' = ${emailTable.checksum}
        AND outcome."completedAt" >= ${emailTable.updatedAt}`
    }
    AND NOT EXISTS (SELECT 1 FROM "RunOperation" newer
      WHERE newer."runId" = outcome."runId" AND newer.kind = outcome.kind
        AND newer.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityId' = ${emailTable.id}::text
        AND newer."completedAt" > outcome."completedAt")
    AND ${newEvidenceAt ? sql`outcome."completedAt" < ${evidenceInstant(newEvidenceAt)}` : sql`true`}
)`;

/**
 * The holder Run left this Email unsettled: an automatic unresolved outcome,
 * or (a Run that failed or stopped after claiming it) no outcome at all, with
 * the holder's frozen roster binding the attempted checksum and its end as the
 * attempt instant. A later member edit/review, changed bytes, or newer outcome
 * prevents reopening.
 * Raw SQL instants use UTC ISO text, never pg's host-local Date encoding.
 */
const untouchedAutomaticUnresolved = (
  sourceChanged = false,
  newEvidenceAt?: Date | SQL,
  /** Evidence recovery's page defers the member-stop check to admission. */
  memberStop = true,
) => sql`(${unresolvedOutcome(sourceChanged, newEvidenceAt)} OR ${outcomeFreeAttempt(sourceChanged, newEvidenceAt)}) AND ${
  memberStop
    ? sql`(NOT ${memberStoppedHolder} OR ${
        sourceChanged
          ? sql`true`
          : newEvidenceAt
            ? sql`${run.endedAt} < ${evidenceInstant(newEvidenceAt)}`
            : sql`false`
      })`
    : sql`true`
} AND NOT EXISTS (
  SELECT 1 FROM ${emailReviewsForEmailSql(sql`${emailTable.id}`)} reviewed
  WHERE reviewed.family = ${suggestionFamily.enum.mail_import_outcome}
    AND reviewed."emailId" = ${emailTable.id} AND reviewed.authority = ${feedbackAuthority.enum.member}
) AND NOT ${emailHasProtectingIntentSql(sql`${emailTable.id}`, sql`${emailTable.orderMailId}`)}`;

/**
 * Frozen inputs retain attempted source/revision pairs even after ownership
 * moves or a release clears the Run's replay key.
 */
// includes-deleted: disposed Run inputs still prove that this source/mapping was attempted.
const unattemptedSenderMapping = (revision: SQL) => sql`NOT EXISTS (
 SELECT 1 FROM "Run" attempted, jsonb_array_elements(coalesce(attempted.input->'sources', '[]'::jsonb)) source
 WHERE attempted."ledgerPartyId" = ${emailTable.ledgerPartyId}
 AND attempted.input->>'evidenceRevision' = ${revision}
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
  sourceChanged = false,
  newEvidenceAt?: Date,
  /** Unattended admission of unchanged evidence honours the attempt bound. */
  bounded = false,
  /** A member's own selection, which may reopen what an ended holder left. */
  memberSelection = false,
) {
  const pairs = requestedRows(
    [
      ...new Map(
        sources.map((source) => [
          JSON.stringify([source.mailboxId, source.messageId]),
          { mailbox: source.mailboxId, message: source.messageId },
        ]),
      ).values(),
    ],
    { mailbox: "text", message: "text" },
    "requested_mail",
  );
  // Retained mail sources are Gmail-only; the provider completes the
  // (party, provider, mailbox, message) unique key so each pair is a point probe.
  const messages: LockedMailSource[] = await tx
    .select(lockedMailSourceFields)
    .from(emailTable)
    .innerJoin(
      pairs.from,
      and(
        eq(emailTable.mailboxId, pairs.col("mailbox")),
        eq(emailTable.messageId, pairs.col("message")),
      ),
    )
    .where(
      and(
        eq(emailTable.ledgerPartyId, partyId),
        eq(emailTable.provider, "gmail"),
      ),
    )
    .for("update", { of: emailTable });
  const owners = new Map<string, typeof run.$inferSelect>();
  const fresh: RetainedMail[] = [];
  const transfers = new Map<RunId, RetainedMail[]>();
  const reopened = new Set<RunId>();
  for (const source of sources) {
    const message = messages.find(
      (candidate) =>
        candidate.mailboxId === source.mailboxId &&
        candidate.messageId === source.messageId,
    );
    if (skipsSource(message, source, controlledParentRunId)) continue;
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
    // A new evidence revision readmits an unsettled Email from any ended holder,
    // failed and retired ones included; the per-revision guard below is what
    // keeps one revision from paying for more than one attempt.
    if (
      senderRevision &&
      owner?.purpose === "mail_import" &&
      (owner.retiredAt || ENDED_MAIL_IMPORT_STATUSES.includes(owner.status)) &&
      message &&
      readmissibleHeldStatus(message.status, sourceChanged) &&
      mailResearchRunInput.safeParse(owner.input).data?.evidenceRevision !==
        senderRevision
    ) {
      const [eligible] = await tx
        .select({ id: emailTable.id })
        .from(emailTable)
        .innerJoin(run, eq(run.id, emailTable.runId))
        .where(
          and(
            eq(emailTable.id, message.id),
            untouchedAutomaticUnresolved(sourceChanged, newEvidenceAt),
            sourceChanged ? undefined : heldUnsettledSql(),
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
        !(await hasLiveRunPassClaim(tx, owner.id))
      ) {
        // A retired coordinator holds nothing to transfer; admit it afresh.
        if (owner.retiredAt) fresh.push(source);
        else
          transfers.set(owner.id, [...(transfers.get(owner.id) ?? []), source]);
        continue;
      }
      if (owner.retiredAt) continue;
    }
    if (
      owner &&
      memberSelection &&
      (await endedHolderLeftUnsettled(tx, owner, message))
    ) {
      fresh.push(source);
      reopened.add(owner.id);
      continue;
    }
    if (sourceChanged && (!owner || owner.retiredAt)) continue;
    if (
      owner &&
      !owner.retiredAt &&
      !CLASSIFICATION_RUN_PURPOSES.includes(owner.purpose)
    ) {
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
        if (await hasLiveRunPassClaim(tx, owner.id))
          throw new WorkDeferredError(
            "Waiting for the queued Mail import's dispatch to finish before transferring its selected sources",
            new Date(Date.now() + 15_000),
            "provider_capacity",
          );
        transfers.set(owner.id, [...(transfers.get(owner.id) ?? []), source]);
      } else owners.set(owner.id, owner);
    } else if (!(bounded && message && importAttemptsExhausted(message)))
      fresh.push(source);
  }
  return { owners, fresh, transfers, reopened };
}

// An isolated admission can spend at most eight seconds in PostgreSQL,
// including its gate wait; a single slow statement can spend three.
const RETAINED_STATEMENT_MS = 3_000;
const RETAINED_TRANSACTION_MS = 8_000;

async function limitRetainedAdmission(
  tx: Database,
  claim?: Pick<Claim, "deadline">,
) {
  if (!claim) return;
  checkPassPageTime(claim);
  await limitPassPageTransaction(
    tx,
    RETAINED_STATEMENT_MS,
    RETAINED_TRANSACTION_MS,
  );
}

export async function admitMailImport(
  db: Database,
  input: MailImportAdmission,
  discoveryClaim?: Pick<Claim, "deadline">,
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
    !input.automatic &&
    !input.parentRunId &&
    input.messageIds.every((id) => selectedSources.has(id));
  // After the member lock. A plain read would keep the snapshot from before
  // that wait. Sharing the Vendor row makes an exclusion that committed
  // during the wait abort this attempt; the retry reads the new proof.
  const senderIdentityFor = async (tx: DrizzleTransaction) => {
    if (!input.senderRecheck) return undefined;
    const sender = input.senderRecheck.sender;
    await tx
      .select({ id: vendor.id })
      .from(vendor)
      .where(
        and(
          notDeleted(vendor),
          or(
            sql`EXISTS (SELECT 1 FROM unnest(${vendor.orderEmailSenders}) AS known(address) WHERE lower(trim(known.address)) = ${sender})`,
            sql`${vendor.orderEmailSenderPolicies} ? ${sender}`,
          ),
        ),
      )
      .for("share");
    return (await readSenderAttributions(tx, [sender]))[0];
  };
  const admit = (writeDb: Database) =>
    withTransaction(writeDb, async (tx) => {
      await tx.execute(sql`SELECT set_config('lock_timeout', '2000', true)`);
      // Admission assigns Emails to Runs and raises their kernel keys; the
      // gate precedes its first row lock.
      await (
        await import("~/server/kernel/api")
      ).enterHouseholdGate(databaseForTransaction(tx));
      await limitRetainedAdmission(databaseForTransaction(tx), discoveryClaim);
      const [parent] = input.parentRunId
        ? await tx
            .select({
              purpose: run.purpose,
              // Admission reads the parent's policy, never its query roster.
              input: sql<unknown>`${run.input} - 'scopedQueries'`,
              vendorId: run.vendorId,
            })
            .from(run)
            .where(eq(run.id, input.parentRunId))
        : [];
      const parentPolicy = mailboxDiscoveryInput
        .omit({ scopedQueries: true })
        .safeParse(parent?.input);
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
        : input.sourceRecheck
          ? await sha256Hex(
              JSON.stringify([
                "retained-source",
                sources.map((source) => [source.id, source.rawChecksum]).sort(),
              ]),
            )
          : input.waitRecheck
            ? await sha256Hex(
                JSON.stringify(["waiting-on", input.waitRecheck.outcomeId]),
              )
            : input.capabilityRecheck
              ? await sha256Hex(
                  JSON.stringify(["importer", MAIL_IMPORT_SKILL_REVISION]),
                )
              : undefined;
      let newEvidenceAt: Date | undefined = input.waitRecheck?.settledAt;
      // After the member lock, so an exclusion that committed while this
      // attempt waited is the proof this attempt uses.
      const senderIdentity = await senderIdentityFor(tx);
      if (input.senderRecheck) {
        if (
          senderIdentity?.state !== "verified" ||
          senderIdentity.vendorId !== input.senderRecheck.vendorId ||
          sources.some(
            (source) =>
              senderAddress(source.sender) !== input.senderRecheck?.sender,
          )
        )
          return [];
        if (input.senderRecheck.purchase) {
          const expected = input.senderRecheck.purchase;
          const current = (
            await importedPurchaseRechecks(
              databaseForTransaction(tx),
              partyId,
              { purchaseId: expected.purchaseId },
            )
          ).find((candidate) => candidate.purchaseId === expected.purchaseId);
          if (
            !current ||
            current.evidenceFingerprint !== expected.evidenceFingerprint ||
            current.orderId !== expected.orderId ||
            current.vendorId !== input.senderRecheck.vendorId
          )
            return [];
          newEvidenceAt = new Date(current.evidenceAt);
          for (const source of sources) {
            const content = mailReadContent(source.content, {});
            if (content.truncated || content.nextByteOffset !== null) return [];
            const candidates = await readMailRuleCandidates(
              databaseForTransaction(tx),
              {
                ledgerPartyId: partyId,
                vendorId: current.vendorUuid,
                orderKeys: (
                  await readEmailMailKeys(databaseForTransaction(tx), source)
                ).orderKeys,
              },
            );
            if (
              !candidates.some(
                (candidate) =>
                  candidate.purchaseId === expected.purchaseId &&
                  candidate.ownAccount &&
                  candidate.importedSource,
              )
            )
              return [];
          }
        }
      }
      const { owners, fresh, transfers, reopened } = await partitionOwnership(
        tx,
        partyId,
        sources,
        controlled ? input.parentRunId : undefined,
        senderRevision,
        input.sourceRecheck,
        newEvidenceAt,
        Boolean(input.automatic && !controlled && !senderRevision),
        !input.automatic && !controlled,
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
        // A reopened source is keyed by the holder it left, so it never
        // replays that ended Run for the same source set.
        const reopenedKey = reopened.size
          ? `reopened:${[...reopened].sort().join(",")}:`
          : "";
        const clientKey = `mail-research:${party.id}:${senderRevision ? `sender-proof:${senderRevision}:` : ""}${controlled ? `controlled:${input.parentRunId}:` : ""}${reopenedKey}${await sha256Hex(
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
          skillRevision: MAIL_IMPORT_SKILL_REVISION,
          input: senderRevision
            ? { ...sourceSet, evidenceRevision: senderRevision }
            : sourceSet,
          clientKey,
          startedAt: new Date(),
          dispatchEventId: crypto.randomUUID(),
          agentSessionId: importRunAgentIdentity(id, "mail_import"),
        });
        if (transferFrom) {
          // transferMailRunSources preserves the old frozen roster and outcomes;
          // each successor names just this owner's selected, still-held sources.
          await emitEmailRunAssignment(
            tx,
            await transferMailRunSources(
              tx,
              transferFrom,
              id,
              admittedSources.map((source) => source.id),
              input.sourceRecheck
                ? new Map(
                    admittedSources.map((source) => [
                      source.id,
                      source.rawChecksum,
                    ]),
                  )
                : undefined,
            ),
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
          const selected = requestedRows(
            admittedSources.map((source) => ({
              party: source.ledgerPartyId,
              mailbox: source.mailboxId,
              message: source.messageId,
              mail: source.id,
              checksum: source.rawChecksum,
            })),
            {
              party: "uuid",
              mailbox: "text",
              message: "text",
              mail: "uuid",
              checksum: "text",
            },
            "requested_mail",
          );
          // Gmail-only sources: the provider completes the unique key.
          const assigned = await tx
            .update(emailTable)
            .set({
              status: "researching",
              runId: id,
              importAttempts: countImportAttempt(senderRevision),
            })
            .from(selected.from)
            .where(
              and(
                eq(emailTable.ledgerPartyId, selected.col("party")),
                eq(emailTable.provider, "gmail"),
                eq(emailTable.mailboxId, selected.col("mailbox")),
                eq(emailTable.messageId, selected.col("message")),
                eq(emailTable.orderMailId, selected.col("mail")),
                eq(emailTable.checksum, selected.col("checksum")),
              ),
            )
            .returning({
              id: emailTable.id,
              orderMailId: emailTable.orderMailId,
            });
          if (assigned.length !== admittedSources.length)
            throw new Error("Mail source ownership assignment is incomplete.");
          await emitEmailRunAssignment(
            tx,
            assigned.map((row) => row.id),
          );
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
  return input.senderRecheck ||
    input.sourceRecheck ||
    input.waitRecheck ||
    input.capabilityRecheck
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

/** How long automatic admission waits after a Run fails transiently. */
const TRANSIENT_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Automatic admission waits while a Run waits for AI funding, or after the
 * latest settled Run failed transiently (provider, gateway or database
 * outage, or a dispatch that never started): admitting again at once would
 * spin, as 540 fifty-Email Runs failed in two hours when no funding could
 * answer. A deterministic failure says nothing about the next Run's Emails,
 * so it holds nothing back; its own claimed Emails stay held as `unsettled`.
 */
async function mailImportHeldBack(db: Database, ledgerPartyId: LedgerPartyId) {
  const party = parseEntityId("ledgerParty", ledgerPartyId);
  const ownMailImports = and(
    eq(run.ledgerPartyId, party),
    eq(run.purpose, "mail_import"),
    notDeleted(run),
  );
  const [paused] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        ownMailImports,
        eq(run.status, runStatus.enum.paused_auth),
        eq(run.failureCode, "execution_limit"),
      ),
    )
    .limit(1);
  if (paused) return true;
  const [latest] = await getDb(db)
    .select({ failureCode: run.failureCode, endedAt: run.endedAt })
    .from(run)
    .where(and(ownMailImports, isNotNull(run.endedAt)))
    .orderBy(desc(run.endedAt))
    .limit(1);
  return (
    (latest?.failureCode === agentFailureCode.enum.agent_transient ||
      latest?.failureCode === runStatus.enum.dispatch_failed) &&
    latest.endedAt !== null &&
    Date.now() - latest.endedAt.getTime() < TRANSIENT_FAILURE_BACKOFF_MS
  );
}

/**
 * A Mail import coordinator already read this Email at its checksum with the
 * sender attributed to this Vendor: the mapping is not new evidence for it.
 * Literal kind and state let a generic plan use the partial claim index.
 */
const claimedWithSenderVendor = (vendorShortcode: SQL) => sql`EXISTS (
  SELECT 1 FROM "RunOperation" claim
  JOIN "Run" claimer ON claimer.id = claim."runId"
  WHERE claimer."ledgerPartyId" = ${emailTable.ledgerPartyId}
    AND claimer.purpose = ${runPurpose.enum.mail_import} AND ${notDeleted("claimer")}
    AND claim.kind = 'claim_next_work' AND claim.state = ${sqlEnumConstant(runStatus, runStatus.enum.completed)}
    AND claim.result #>> '{email,mailboxId}' = ${emailTable.mailboxId}
    AND claim.result #>> '{email,messageId}' = ${emailTable.messageId}
    AND claim.result #>> '{email,checksum}' = ${emailTable.checksum}
    AND claim.result #>> '{known,senderVendor,id}' = ${vendorShortcode}
)`;

/** Gaps an agent settles: an importer that learns more may settle them itself. */
const AGENT_GAP_CATEGORIES = Object.entries(MAIL_IMPORT_GAP_EXECUTOR).flatMap(
  ([category, executor]) => (executor === "agent" ? [category] : []),
);
const capabilityRevision = () =>
  sha256Hex(JSON.stringify(["importer", MAIL_IMPORT_SKILL_REVISION]));

/** The holder Run's newest outcome for the Email, when it is an unresolved one at the current checksum. */
const newestUnresolvedOutcome = sql`SELECT o.result, o."completedAt" FROM "RunOperation" o
  WHERE o."runId" = ${run.id} AND o.kind = ${"target_outcome"} AND o.state = ${runStatus.enum.completed}
    AND (o.result->'mailOutcome') IS NOT NULL
    AND o.result #>> '{target,entityId}' = ${emailTable.id}::text
    AND o.result #>> '{mailOutcome,checksum}' = ${emailTable.checksum}
    AND o.result #>> '{mailOutcome,judgment,kind}' = ${"unresolved"}
    AND NOT EXISTS (SELECT 1 FROM "RunOperation" newer
      WHERE newer."runId" = o."runId" AND newer.kind = o.kind
        AND newer.result #>> '{target,entityId}' = ${emailTable.id}::text
        AND newer."completedAt" > o."completedAt")
  ORDER BY o."completedAt" DESC, o.id DESC LIMIT 1`;

/** The holder Run's newest unresolved outcome for the Email's current checksum. */
const newestHolderOutcome = sql`SELECT o.result, o."completedAt" FROM "RunOperation" o
  WHERE o."runId" = ${run.id} AND o.kind = ${"target_outcome"} AND o.state = ${runStatus.enum.completed}
    AND (o.result->'mailOutcome') IS NOT NULL
    AND o.result #>> '{target,entityId}' = ${emailTable.id}::text
    AND o.result #>> '{mailOutcome,checksum}' = ${emailTable.checksum}
    AND o.result #>> '{mailOutcome,judgment,kind}' = ${"unresolved"}
    AND (o.result #> '{mailOutcome,judgment,waitingOn}') IS NOT NULL
    AND jsonb_typeof(o.result #> '{mailOutcome,judgment,waitingOn}') = 'object'
    AND NOT EXISTS (SELECT 1 FROM "RunOperation" newer
      WHERE newer."runId" = o."runId" AND newer.kind = o.kind
        AND newer.result #>> '{target,entityId}' = ${emailTable.id}::text
        AND newer."completedAt" > o."completedAt")
  ORDER BY o."completedAt" DESC, o.id DESC LIMIT 1`;

/** `sha256Hex(JSON.stringify(["waiting-on", outcomeId]))`, admission's waitRecheck revision. */
const waitRecheckRevisionSql = sql`encode(sha256(convert_to('["waiting-on",' || to_json(newest.result #>> '{mailOutcome,id}')::text || ']', 'UTF8')), 'hex')`;

/**
 * When the source an unresolved outcome waits on last settled: a live,
 * owner-eligible Purchase holding the awaited order (at the awaited Vendor
 * when known) was created or gained an accepted source, or the awaited Email
 * was imported or linked. Null while it has not.
 */
const waitedSourceSettledSql = sql`SELECT max(at) AS at FROM (
  SELECT greatest(p."createdAt", (SELECT max(accepted."createdAt") FROM ${acceptedOrdersBoundToSql((id) => sql`${id} = p.id`)} accepted)) AS at
  FROM ${purchase} p
  LEFT JOIN ${vendorAccount} account ON account.id = p."vendorAccountId" AND ${notDeleted("account")}
  WHERE newest.result #>> '{mailOutcome,judgment,waitingOn,kind}' = ${"order"}
    AND ${notDeleted("p")}
    AND ${matchingOrderIdSql(sql`p."orderId"`, sql`newest.result #>> '{mailOutcome,judgment,waitingOn,orderId}'`)}
    AND (newest.result #>> '{mailOutcome,judgment,waitingOn,vendorId}' IS NULL
      OR p."vendorId"::text = newest.result #>> '{mailOutcome,judgment,waitingOn,vendorId}')
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = ${emailTable.ledgerPartyId})
  UNION ALL
  SELECT awaited."completedAt" FROM "RunOperation" awaited
  WHERE newest.result #>> '{mailOutcome,judgment,waitingOn,kind}' = ${"email"}
    AND awaited.kind = ${"target_outcome"} AND awaited.state = ${runStatus.enum.completed}
    AND (awaited.result->'mailOutcome') IS NOT NULL
    AND awaited.result #>> '{target,entityId}' = newest.result #>> '{mailOutcome,judgment,waitingOn,emailId}'
    AND awaited.result #>> '{mailOutcome,judgment,kind}' IN (${"imported"}, ${"linked"})
) source`;

export const retainedAdmissionCursor = z.object({
  through: z.uuid(),
  mailbox: z.string().nullable(),
  stage: z.number().int().min(0).max(5),
  finished: z.array(z.string()),
  timedOut: z.array(z.string()).default([]),
});

export async function importPendingEmails(
  db: Database,
  options: {
    after?: string | null;
    learnSenders?: boolean;
    resume?: z.infer<typeof retainedAdmissionCursor> | null;
    claim?: Pick<Claim, "deadline">;
  } = {},
) {
  const { listMemberMailboxes } =
    await import("~/server/domains/purchase-import/repo/gmail/targets");
  const { mailImportEnabled } =
    await import("~/server/domains/purchase-import/repo/mail-import-settings");
  const { retainedEmailImportContentCondition } =
    await import("~/server/domains/purchase-import/repo/email-content");
  const transaction: PassPageTransaction = (work) =>
    withPassPageTransaction(
      db,
      work,
      options.claim,
      RETAINED_STATEMENT_MS,
      RETAINED_TRANSACTION_MS,
    );
  const size = 50;
  // includes-deleted: the UUID cursor advances past every row before eligibility checks.
  const page = await transaction((tx) =>
    getDb(tx)
      .select({
        id: emailTable.id,
        sender: emailTable.sender,
        mailboxId: emailTable.mailboxId,
        ledgerPartyId: emailTable.ledgerPartyId,
        orderMailId: emailTable.orderMailId,
      })
      .from(emailTable)
      .where(
        and(
          options.after
            ? gt(emailTable.id, emailId.parse(options.after))
            : undefined,
          options.resume
            ? lte(emailTable.id, emailId.parse(options.resume.through))
            : undefined,
        ),
      )
      .orderBy(emailTable.id)
      .limit(size),
  );
  const after =
    options.resume?.through ?? (page.length === size ? page.at(-1)!.id : null);
  const errors: unknown[] = [];
  const last = page.at(-1);
  if (!last) return { errors, after, resume: null };
  const checkpoint = options.resume
    ? { ...options.resume }
    : { through: last.id, mailbox: null, stage: 0, finished: [], timedOut: [] };
  const finished = new Set(checkpoint.finished);
  const timedOut = new Set(checkpoint.timedOut);
  const pageIds = sql`${emailTable.id} = ANY(${uuidArrayParam(page.map(({ id }) => id))})`;
  const admit = (input: MailImportAdmission) => {
    checkPassPageTime(options.claim);
    return admitMailImport(db, input, options.claim);
  };
  const recordItemError = (id: string, error: unknown) => {
    rethrowPassPageControl(error);
    errors.push(error);
    const code = findPgError(error)?.code;
    if (code === "57014" || code === "57P05") timedOut.add(id);
  };
  const admitBatch = async <Row extends { id: string }>(
    rows: readonly Row[],
    admitItems: (items: readonly Row[]) => Promise<object>,
    revision = "",
  ) => {
    const key = (row: Row) => `${revision}:${row.id}`;
    const remaining = rows.filter(
      (row) => !timedOut.has(row.id) && !finished.has(key(row)),
    );
    if (!remaining.length) return;
    try {
      await admitItems(remaining);
      for (const row of remaining) finished.add(key(row));
    } catch (error) {
      if (remaining.length === 1) {
        recordItemError(remaining[0]!.id, error);
        finished.add(key(remaining[0]!));
        return;
      }
      rethrowPassPageControl(error);
      // The batch rolled back. Admit individually so healthy siblings can
      // progress and a timed-out source is checkpointed like any other failure.
      for (const row of remaining) {
        try {
          await admitItems([row]);
        } catch (itemError) {
          recordItemError(row.id, itemError);
        }
        finished.add(key(row));
      }
    }
  };
  const runStage = async (stage: number, work: () => Promise<void>) => {
    if (checkpoint.stage > stage) return;
    await work();
    checkpoint.stage = stage + 1;
    finished.clear();
  };

  try {
    const knownAttributions = await transaction((tx) =>
      readSenderAttributions(tx, [
        ...new Set(
          page.flatMap(({ sender }) => {
            const address = senderAddress(sender);
            return address ? [address] : [];
          }),
        ),
      ]),
    );
    if (options.learnSenders && checkpoint.mailbox === null)
      await transaction((tx) =>
        learnAcceptedSenders(tx, systemActor(), knownAttributions),
      );
    const identities = knownAttributions.filter(
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
    const importerRevision = await capabilityRevision();
    const mailboxes = await transaction(listMemberMailboxes);
    const mailboxKey = (target: (typeof mailboxes)[number]) =>
      `${target.ledgerPartyId}:${target.mailboxId}`;
    for (const target of mailboxes.sort((a, b) =>
      mailboxKey(a).localeCompare(mailboxKey(b)),
    )) {
      const key = mailboxKey(target);
      if (
        checkpoint.mailbox !== null &&
        key.localeCompare(checkpoint.mailbox) < 0
      )
        continue;
      if (key !== checkpoint.mailbox) {
        checkpoint.mailbox = key;
        checkpoint.stage = 0;
        finished.clear();
      }
      if (checkpoint.stage === 5) continue;
      if (
        !page.some(
          (row) =>
            row.orderMailId &&
            row.ledgerPartyId === target.ledgerPartyId &&
            row.mailboxId === target.mailboxId,
        )
      )
        continue;
      const actorId = target.userId;
      if (!actorId) continue;
      if (!(await transaction((tx) => mailImportEnabled(tx, target.mailboxId))))
        continue;
      if (
        await transaction((tx) => mailImportHeldBack(tx, target.ledgerPartyId))
      )
        continue;
      await runStage(0, async () => {
        const pending = await transaction((tx) =>
          getDb(tx)
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
                pageIds,
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
                sql`NOT ${importAttemptsExhaustedSql}`,
                notDeleted(emailTable),
              ),
            )
            .orderBy(asc(emailTable.createdAt), asc(emailTable.id)),
        );
        await admitBatch(pending, (items) =>
          admit({
            ledgerPartyId: target.ledgerPartyId,
            userId: actorId,
            mailboxId: target.mailboxId,
            automatic: true,
            messageIds: items.map(({ id }) => id),
          }),
        );
      });
      await runStage(1, async () => {
        const changed = await transaction((tx) =>
          getDb(tx)
            .select({ id: orderMail.id, checksum: orderMail.rawChecksum })
            .from(emailTable)
            .innerJoin(
              orderMail,
              and(
                eq(orderMail.id, emailTable.orderMailId),
                eq(orderMail.rawChecksum, emailTable.checksum),
              ),
            )
            .innerJoin(run, eq(run.id, emailTable.runId))
            .where(
              and(
                pageIds,
                eq(
                  emailTable.ledgerPartyId,
                  parseEntityId("ledgerParty", target.ledgerPartyId),
                ),
                eq(emailTable.mailboxId, target.mailboxId),
                eq(emailTable.status, "pending"),
                eq(emailTable.classification, "related"),
                eq(run.purpose, "mail_import"),
                inArray(run.status, ENDED_MAIL_IMPORT_STATUSES),
                notDeleted(run),
                notDeleted(emailTable),
                retainedEmailImportContentCondition(),
                untouchedAutomaticUnresolved(true),
              ),
            )
            .orderBy(asc(emailTable.createdAt), asc(emailTable.id)),
        );
        await admitBatch(changed, (items) =>
          admit({
            ledgerPartyId: target.ledgerPartyId,
            userId: actorId,
            mailboxId: target.mailboxId,
            automatic: true,
            sourceRecheck: true,
            messageIds: items.map((row) => row.id),
            expectedChecksums: items.map((row) => ({
              orderMailId: row.id,
              checksum: row.checksum,
            })),
          }),
        );
      });
      await runStage(2, async () => {
        const waiting = await transaction((tx) =>
          getDb(tx)
            .select({
              id: orderMail.id,
              rawChecksum: orderMail.rawChecksum,
              outcomeId: sql<string>`newest.result #>> '{mailOutcome,id}'`.as(
                "outcomeId",
              ),
              settledAt: sql<string>`settled.at::text`.as("settledAt"),
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
            .innerJoin(sql`LATERAL (${newestHolderOutcome}) newest`, sql`true`)
            .innerJoin(
              sql`LATERAL (${waitedSourceSettledSql}) settled`,
              sql`true`,
            )
            .where(
              and(
                pageIds,
                eq(
                  emailTable.ledgerPartyId,
                  parseEntityId("ledgerParty", target.ledgerPartyId),
                ),
                eq(emailTable.mailboxId, target.mailboxId),
                heldUnsettledSql(),
                eq(emailTable.classification, "related"),
                eq(run.purpose, "mail_import"),
                inArray(run.status, ENDED_MAIL_IMPORT_STATUSES),
                notDeleted(run),
                notDeleted(emailTable),
                retainedEmailImportContentCondition(),
                sql`settled.at > newest."completedAt"`,
                // Admission's own eligibility: without it, a row admission refuses
                // is re-admitted on every discovery pass.
                untouchedAutomaticUnresolved(false, sql`settled.at`),
                unattemptedSenderMapping(waitRecheckRevisionSql),
              ),
            )
            .orderBy(asc(emailTable.createdAt), asc(emailTable.id)),
        );
        for (const row of waiting)
          await admitBatch([row], () =>
            admit({
              ledgerPartyId: target.ledgerPartyId,
              userId: actorId,
              mailboxId: target.mailboxId,
              automatic: true,
              messageIds: [row.id],
              expectedChecksums: [
                { orderMailId: row.id, checksum: row.rawChecksum },
              ],
              waitRecheck: {
                outcomeId: row.outcomeId,
                settledAt: new Date(row.settledAt.replace(" ", "T") + "Z"),
              },
            }),
          );
      });
      await runStage(3, async () => {
        const outdated = await transaction((tx) =>
          getDb(tx)
            .select({ id: orderMail.id, checksum: orderMail.rawChecksum })
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
              sql`LATERAL (${newestUnresolvedOutcome}) newest`,
              sql`true`,
            )
            .where(
              and(
                pageIds,
                eq(
                  emailTable.ledgerPartyId,
                  parseEntityId("ledgerParty", target.ledgerPartyId),
                ),
                eq(emailTable.mailboxId, target.mailboxId),
                heldUnsettledSql(),
                eq(emailTable.classification, "related"),
                eq(run.purpose, "mail_import"),
                inArray(run.status, ENDED_MAIL_IMPORT_STATUSES),
                ne(run.skillRevision, MAIL_IMPORT_SKILL_REVISION),
                notDeleted(run),
                notDeleted(emailTable),
                retainedEmailImportContentCondition(),
                sql`coalesce(newest.result #>> '{mailOutcome,judgment,category}', ${"unknown"}) IN (${sql.join(
                  AGENT_GAP_CATEGORIES.map((category) => sql`${category}`),
                  sql`, `,
                )})`,
                unattemptedSenderMapping(sql`${importerRevision}`),
              ),
            )
            .orderBy(asc(emailTable.createdAt), asc(emailTable.id)),
        );
        await admitBatch(outdated, (items) =>
          admit({
            ledgerPartyId: target.ledgerPartyId,
            userId: actorId,
            mailboxId: target.mailboxId,
            automatic: true,
            capabilityRecheck: true,
            messageIds: items.map((row) => row.id),
            expectedChecksums: items.map((row) => ({
              orderMailId: row.id,
              checksum: row.checksum,
            })),
          }),
        );
      });
      await runStage(4, async () => {
        if (!recheckIdentities.length) return;
        const senderRows = await transaction((tx) =>
          getDb(tx)
            .select({
              id: orderMail.id,
              sender: sql<string>`sender_identity.sender`,
              vendorId: sql<string>`sender_identity."vendorId"`,
              revision: sql<string>`sender_identity.revision`,
              senderEligible: sql<boolean>`${unattemptedSenderMapping(sql`sender_identity.revision`)} AND coalesce(${run.input}->>'evidenceRevision', '') <> sender_identity.revision AND NOT ${memberStoppedHolder} AND NOT ${claimedWithSenderVendor(sql`sender_identity."vendorId"`)}`,
              // An outcome-free attempt dates from its holder's end; evidence must
              // also postdate a member's cancel.
              outcomeAt:
                sql<Date | null>`greatest(coalesce((SELECT max(prior."completedAt") FROM "RunOperation" prior
              WHERE prior."runId" = ${run.id} AND prior.kind = ${"target_outcome"} AND prior.state = ${runStatus.enum.completed}
              AND prior.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'entityId' = ${emailTable.id}::text
              AND prior.result->${runTargetOutcomeReceipt.keyof().enum.target}::text->>'state' = ${"unresolved"}), ${run.endedAt}), CASE WHEN ${memberStoppedHolder} THEN ${run.endedAt} END)`.mapWith(
                  runOperation.completedAt,
                ),
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
            // Normalize each sender once. As a join filter it ran for every
            // Email × identity pair.
            .innerJoin(
              sql`LATERAL (SELECT lower(trim(coalesce(substring(${emailTable.sender} from '<([^>]+)>'), ${emailTable.sender}))) AS sender OFFSET 0) email_sender`,
              sql`true`,
            )
            .innerJoin(
              sql`jsonb_to_recordset(${JSON.stringify(recheckIdentities)}::jsonb) AS sender_identity(sender text, "vendorId" text, revision text)`,
              sql`email_sender.sender = sender_identity.sender`,
            )
            .where(
              and(
                pageIds,
                eq(
                  emailTable.ledgerPartyId,
                  parseEntityId("ledgerParty", target.ledgerPartyId),
                ),
                eq(emailTable.mailboxId, target.mailboxId),
                heldUnsettledSql(),
                eq(emailTable.classification, "related"),
                or(
                  isNull(emailTable.classificationVersion),
                  ne(
                    emailTable.classificationVersion,
                    HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
                  ),
                ),
                eq(run.purpose, "mail_import"),
                inArray(run.status, ENDED_MAIL_IMPORT_STATUSES),
                notDeleted(run),
                notDeleted(emailTable),
                retainedEmailImportContentCondition(),
                untouchedAutomaticUnresolved(false, undefined, false),
                sql`NOT EXISTS (SELECT 1 FROM (${emailPurchaseEvidenceSql()}) evidence WHERE evidence.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked}))`,
              ),
            )
            .orderBy(asc(emailTable.id)),
        );
        if (!senderRows.length) return;
        const originals = await transaction((tx) =>
          readRetainedMail(tx, {
            ledgerPartyIds: [
              parseEntityId("ledgerParty", target.ledgerPartyId),
            ],
            orderMailIds: senderRows.map((row) => row.id),
          }),
        );
        const complete = originals.filter((original) => {
          const content = mailReadContent(original.content, {});
          return !content.truncated && content.nextByteOffset === null;
        });
        const identifiers = new Map(
          [
            ...(await transaction((tx) =>
              readEmailMailKeysForMails(tx, complete),
            )),
          ].map(([id, keys]) => [id, keys.orderKeys]),
        );
        const imported = await transaction((tx) =>
          importedPurchaseRechecks(tx, target.ledgerPartyId, {
            orderIds: [...new Set([...identifiers.values()].flat())],
            vendorIds: [...new Set(senderRows.map((row) => row.vendorId))],
          }),
        );
        const candidates: {
          id: string;
          sender: string;
          vendorId: string;
          revision: string;
          purchase?: PurchaseRecheck;
        }[] = [];
        for (const row of senderRows) {
          const printed = new Set(identifiers.get(row.id) ?? []);
          const relevant = imported.filter(
            (candidate) =>
              candidate.vendorId === row.vendorId &&
              printed.has(normalizeOrderKey(candidate.orderId)) &&
              row.outcomeAt &&
              new Date(candidate.evidenceAt) > row.outcomeAt,
          );
          for (const candidate of relevant) {
            const purchase = {
              purchaseId: candidate.purchaseId,
              orderId: candidate.orderId,
              evidenceFingerprint: candidate.evidenceFingerprint,
            };
            candidates.push({
              id: row.id,
              sender: row.sender,
              vendorId: row.vendorId,
              purchase,
              revision: await senderRecheckRevision({
                sender: row.sender,
                vendorId: row.vendorId,
                purchase,
              }),
            });
          }
          if (!relevant.length && row.senderEligible)
            candidates.push({
              id: row.id,
              sender: row.sender,
              vendorId: row.vendorId,
              revision: row.revision,
            });
        }
        const groups = new Map<string, typeof candidates>();
        for (const row of candidates)
          groups.set(row.revision, [...(groups.get(row.revision) ?? []), row]);
        for (const group of groups.values()) {
          const identity = group[0];
          if (!identity) continue;
          await admitBatch(
            group,
            (items) =>
              admit({
                ledgerPartyId: target.ledgerPartyId,
                userId: actorId,
                mailboxId: target.mailboxId,
                automatic: true,
                messageIds: items.map((row) => row.id),
                senderRecheck: {
                  sender: identity.sender,
                  vendorId: identity.vendorId,
                  ...(identity.purchase ? { purchase: identity.purchase } : {}),
                },
              }),
            identity.revision,
          );
        }
      });
    }
  } catch (error) {
    if (!(error instanceof PassPageBudgetError)) throw error;
    return {
      errors,
      after: options.after ?? null,
      resume: {
        ...checkpoint,
        finished: [...finished],
        timedOut: [...timedOut],
      },
    };
  }
  return { errors, after, resume: null };
}
