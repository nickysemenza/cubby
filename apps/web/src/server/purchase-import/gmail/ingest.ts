import type { EmailReclassifyOutcome } from "@cubby/schemas/email-actions";
import { emailCandidateSource } from "@cubby/schemas/email-candidates";
import type { EmailClassificationConflict } from "@cubby/schemas/email-observations";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  MAILBOX_RESEARCH_VERSION,
  mailboxClassification,
  mailboxClassificationStage,
  type MailboxClassification,
  type MailboxClassificationDecision,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  email as emailTable,
  orderMail,
  orderMailAttachment,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import { hasAcceptedEmailAssociation } from "~/server/repo/email";
import { emailMemberClassificationSql } from "~/server/repo/email-sql";
import { claimRunExecution } from "~/server/runs/execution-context";

import { hasRetainedEmailImportContent } from "../email-content";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
import {
  deferClassificationRefresh,
  publishGmailEvidence,
} from "./admitted-source";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import {
  extractEmailCandidatePreview,
  type EmailCandidateChoice,
} from "./candidate-extraction";
import { originalChecksum } from "./checksum";
import { gmailExecutionPolicy } from "./execution-policy";
import { normalizeMessage } from "./normalize";
import {
  recordEmailClassificationObservation,
  recordEmailCandidateObservation,
  recordEmailRetrievalFailure,
} from "./observations";
import {
  attachmentHasRetainedBytes,
  clearUnrelatedOriginal,
  readEmail,
  saveEmail,
  saveMailboxMetadata,
  markEmailRemoved,
  storeOrderMailAttachment,
  reserveGmailAttachmentUploads,
  upsertOrderMail,
} from "./persistence";
import { interpretMailRelevance, type MailRelevance } from "./relevance";
import { GmailAuthorizationError } from "./tokens";
import {
  gmailOriginalComplete,
  routeGmailMessage,
  type MailTriage,
} from "./triage";
import type { GmailClassificationCall } from "./triage-model";
import {
  GmailApiError,
  type GmailProvider,
  type GmailMessage,
  type GmailNormalizedMessage,
} from "./types";

export type GmailIngestOutcome = {
  saved: string[];
  orderMailIds: string[];
  deleted: string[];
  excluded: string[];
  unrelated: string[];
  blocked: string[];
  /** Reclassify kept the current Relevance and recorded the rerun as history. */
  kept: { messageId: string; reason: ReclassifyKeptReason }[];
  /** Reclassify reached the current Relevance again. */
  confirmed: string[];
  candidatePreviews: NonNullable<
    Awaited<ReturnType<typeof relatedEmailPreview>>
  >[];
};
type IngestInput = Parameters<typeof ingestGmailMessages>[2];
type MessageIdentity = Pick<IngestInput, "ledgerPartyId" | "mailboxId"> & {
  messageId: string;
};

const routingPorts = (
  db: Database,
  input: IngestInput,
  onCall: (call: GmailClassificationCall) => void,
) =>
  ({
    triage:
      input.triage ??
      (async (content) => {
        if (!input.runId)
          throw new Error("Gmail triage requires its discovery or search Run");
        const { productionMailTriage } = await import("./triage-model");
        return productionMailTriage(db, input.runId, onCall)(content);
      }),
    relevance:
      input.relevance ??
      (async (request) => {
        if (!input.runId)
          throw new Error(
            "Gmail relevance interpretation requires its discovery or search Run",
          );
        const { productionMailRelevance } = await import("./triage-model");
        return productionMailRelevance(db, input.runId, onCall)(request);
      }),
  }) satisfies { triage: MailTriage; relevance: MailRelevance };

const retainOriginal = async (
  db: Database,
  identity: MessageIdentity,
  normalized: GmailNormalizedMessage,
  checksum: string,
  storage: OrderMailAttachmentStorage,
  transientAttachments: ReadonlyMap<string, string>,
  uploadKeys: ReadonlyMap<string, string>,
) => {
  const orderMailId = await upsertOrderMail(
    db,
    identity.ledgerPartyId,
    normalized.mail,
    checksum,
  );
  for (const attachment of normalized.attachments)
    await storeOrderMailAttachment(db, {
      orderMailId,
      attachment,
      storage,
      uploadKey: uploadKeys.get(attachment.sourceKey),
      fetchData: async () =>
        attachment.dataBase64Url ??
        transientAttachments.get(attachment.sourceKey) ??
        undefined,
    });
  return orderMailId;
};

const unchangedClassification = (
  prior: Awaited<ReturnType<typeof readEmail>>,
  checksum: string,
) =>
  prior?.checksum === checksum &&
  prior.classification !== null &&
  prior.classificationVersion === MAILBOX_RESEARCH_VERSION &&
  prior.status !== "excluded" &&
  prior.status !== "deleted";

// Uncertainty is research work when source content is available; absent bytes
// remain an explicit gap rather than an invented retained original.
const retainResearchOriginal = (
  classification: MailboxClassification,
  normalized: GmailNormalizedMessage,
  transientAttachments: ReadonlyMap<string, string>,
) =>
  classification === "related" ||
  (classification === "uncertain" &&
    Boolean(
      normalized.mail.bodyText?.trim() ||
      normalized.mail.bodyHtml?.trim() ||
      transientAttachments.size ||
      normalized.attachments.length,
    ));

/**
 * The classification and why: an unchanged message keeps its recorded verdict;
 * otherwise rules and Jev decide. Import-authorized work can settle uncertainty.
 */
async function classifyMessage(
  prior: Awaited<ReturnType<typeof readEmail>>,
  route: () => Promise<MailboxClassificationDecision>,
  relevance: (() => ReturnType<typeof interpretMailRelevance>) | null,
): Promise<MailboxClassificationDecision> {
  const decision: MailboxClassificationDecision = prior
    ? {
        classification: mailboxClassification.parse(prior.classification),
        stage: mailboxClassificationStage.parse(
          prior.classificationStage ?? "rule",
        ),
        reason:
          prior.classificationReason ??
          "Unchanged since its last classification",
      }
    : await route();
  if (decision.classification !== "uncertain" || !relevance) return decision;
  const settled = await relevance();
  return {
    classification: settled.classification,
    stage: "model",
    reason:
      settled.reason ??
      `The relevance model classified the message ${settled.classification}`,
  };
}

function classificationCallFor(
  stage: MailboxClassificationDecision["stage"],
  triage: GmailClassificationCall | null,
  relevance: GmailClassificationCall | null,
) {
  return stage === "jev" ? triage : stage === "model" ? relevance : null;
}

type PriorMessage = Awaited<ReturnType<typeof readEmail>>;
/** Accepted Purchases outrank the member's review; both are protected evidence. */
async function classificationConflict(
  db: Database,
  identity: MessageIdentity,
  prior: NonNullable<PriorMessage>,
  checksum: string,
  decision: MailboxClassificationDecision,
  acceptedOnly: boolean,
): Promise<EmailClassificationConflict | null> {
  if (
    decision.classification === "unrelated" &&
    (await hasAcceptedEmailAssociation(db, identity))
  )
    return { kind: "accepted_unrelated" };
  if (
    acceptedOnly ||
    decision.stage === "resolution" ||
    prior.checksum !== checksum
  )
    return null;
  const [member] = await getDb(db)
    .select({ classification: emailMemberClassificationSql() })
    .from(emailTable)
    .where(eq(emailTable.id, prior.id))
    .limit(1);
  return member?.classification &&
    member.classification !== decision.classification
    ? { kind: "member_review", memberClassification: member.classification }
    : null;
}

async function observeClassification(
  db: Database,
  input: IngestInput,
  identity: MessageIdentity,
  prior: PriorMessage,
  checksum: string,
  decision: MailboxClassificationDecision,
  unchanged: boolean,
  call: GmailClassificationCall | null,
) {
  if (!prior) return;
  // A reused verdict records nothing new unless it now contradicts a Purchase.
  const conflict = await classificationConflict(
    db,
    identity,
    prior,
    checksum,
    decision,
    unchanged,
  );
  if (unchanged && !conflict) return;
  await recordEmailClassificationObservation(db, {
    emailId: prior.id,
    runId: input.runId ?? null,
    checksum,
    classification: decision.classification,
    stage: decision.stage,
    reason: decision.reason,
    classificationVersion: MAILBOX_RESEARCH_VERSION,
    model: call?.model ?? null,
    promptVersion: call?.promptVersion ?? null,
    operation: call?.operation ?? null,
    conflict,
  });
}

type ReclassifyKeptReason = Extract<
  EmailReclassifyOutcome,
  "awaiting_acceptance" | "resolution_kept"
>;
async function hasRetainedContent(
  db: Database,
  email: NonNullable<PriorMessage>,
) {
  if (!email.orderMailId || email.contentClearedAt) return false;
  const [original] = await getDb(db)
    .select({ content: orderMail.content })
    .from(orderMail)
    .where(eq(orderMail.id, email.orderMailId))
    .limit(1);
  return hasRetainedEmailImportContent(
    getDb(db),
    email.orderMailId,
    original?.content ?? null,
  );
}

/**
 * Reclassify replaces Relevance only when the member keeps what they have: a
 * resolution stands, and a rerun that would drop retained content or an
 * imported Email waits for the member to accept it. A confirming rerun of an
 * Email whose content is gone publishes normally so the refetched original is
 * retained again. `null` publishes normally.
 */
async function reclassifyPublication(
  db: Database,
  current: NonNullable<PriorMessage>,
  decision: MailboxClassificationDecision,
  retain: boolean,
): Promise<GmailAcquisitionOutcome | null> {
  if (current.classificationStage === "resolution")
    return { kind: "kept", reason: "resolution_kept" };
  const imported =
    current.classification !== "unrelated" &&
    (current.status === "completed" || current.status === "researching");
  if (decision.classification === current.classification) {
    if (retain && !imported && !(await hasRetainedContent(db, current)))
      return null;
    await getDb(db)
      .update(emailTable)
      .set({
        classificationStage: decision.stage,
        classificationReason: decision.reason,
        classificationVersion: MAILBOX_RESEARCH_VERSION,
        updatedAt: new Date(),
      })
      .where(eq(emailTable.id, current.id));
    return { kind: "confirmed" };
  }
  if (imported) return { kind: "kept", reason: "awaiting_acceptance" };
  return !retain && (await hasRetainedContent(db, current))
    ? { kind: "kept", reason: "awaiting_acceptance" }
    : null;
}
async function protectOriginalOutcome(
  db: Database,
  identity: MessageIdentity,
  original: { orderMailId: string; checksum: string },
  prior: PriorMessage,
): Promise<
  { kind: "skipped" | "blocked" } | { kind: "saved"; orderMailId: string }
> {
  const status =
    prior?.status === "completed" || prior?.status === "blocked"
      ? prior.status
      : "pending";
  await saveEmail(db, {
    ...identity,
    ...original,
    classification: "related",
    classificationStage: prior?.classificationStage
      ? mailboxClassificationStage.parse(prior.classificationStage)
      : undefined,
    classificationReason:
      prior?.classificationReason ??
      "Accepted source association protects original content",
    status,
  });
  if (status === "completed") return { kind: "skipped" };
  if (status === "blocked") return { kind: "blocked" };
  return { kind: "saved", orderMailId: original.orderMailId };
}
async function fetchObservedMessage(
  db: Database,
  provider: GmailProvider,
  identity: MessageIdentity,
  runId?: string,
) {
  try {
    return {
      message: await provider.getMessage(identity.messageId),
      missing: null,
    };
  } catch (error) {
    if (error instanceof GmailAuthorizationError) throw error;
    // A first 404 must mint its diagnostic owner inside fenced publication.
    // Creating it before the optimistic check would invalidate our own snapshot.
    if (error instanceof GmailApiError && error.status === 404)
      return { message: null, missing: error };
    await recordEmailRetrievalFailure(db, {
      ...identity,
      runId,
      httpStatus: error instanceof GmailApiError ? error.status : null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function stageGmailAttachments(
  db: Database,
  provider: GmailProvider,
  identity: MessageIdentity,
  normalized: GmailNormalizedMessage,
  orderMailId: string | null,
  transientAttachments: Map<string, string>,
) {
  for (const attachment of normalized.attachments) {
    if (
      orderMailId &&
      (await attachmentHasRetainedBytes(db, {
        orderMailId: orderMailId,
        attachment,
      }))
    )
      continue;
    const inline =
      attachment.dataBase64Url ??
      transientAttachments.get(attachment.sourceKey);
    const payload = inline
      ? { data: inline, size: attachment.size }
      : attachment.attachmentId
        ? await provider.getAttachment(
            identity.messageId,
            attachment.attachmentId,
          )
        : {};
    if (payload.data)
      transientAttachments.set(attachment.sourceKey, payload.data);
  }
  return reserveGmailAttachmentUploads(db, {
    orderMailId,
    attachments: normalized.attachments,
    payloads: transientAttachments,
  });
}

/** Member search judges itself; otherwise import policy or a Reclassify runs the model. */
const relevanceModelRuns = (
  input: IngestInput,
  executionPolicy: Awaited<ReturnType<typeof gmailExecutionPolicy>>,
) =>
  !input.callerJudges &&
  (executionPolicy !== "classification_only" || Boolean(input.reclassify));

function recordUnsavedOutcome(
  outcome: GmailIngestOutcome,
  messageId: string,
  result: Exclude<GmailAcquisitionOutcome, { kind: "saved" }>,
) {
  if (result.kind === "kept")
    outcome.kept.push({ messageId, reason: result.reason });
  else if (result.kind !== "skipped") outcome[result.kind].push(messageId);
}

type GmailAcquisitionOutcome =
  | { kind: "saved"; orderMailId: string }
  | { kind: "kept"; reason: ReclassifyKeptReason }
  | { kind: "unrelated" | "blocked" | "skipped" | "confirmed" };

async function cleanNewGmailKeys(
  createdKeys: Set<string>,
  storage: OrderMailAttachmentStorage,
  error: Error,
): Promise<never> {
  const cleanup = await Promise.allSettled(
    [...createdKeys].map((key) => storage.delete(key)),
  );
  const failures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(
      [error, ...failures],
      [error, ...failures]
        .map((value) =>
          value instanceof Error ? value.message : String(value),
        )
        .join("\n"),
      { cause: error },
    );
  throw error;
}

function unchangedRetainedOutcome(
  prior: PriorMessage,
): GmailAcquisitionOutcome | null {
  if (!prior?.orderMailId) return null;
  if (prior.status === "completed") return { kind: "skipped" };
  return prior.status === "researching"
    ? { kind: "saved", orderMailId: prior.orderMailId }
    : null;
}

/**
 * A member's search retains only new matches as `uncertain`; an Email whose
 * Relevance is already decided keeps its classification, stage and retained
 * content even when its version or checksum is stale. Removed Email, or an
 * uncertain match whose content was disposed, is new again.
 */
function memberSearchOwnership(
  input: IngestInput,
  prior: PriorMessage,
  executionPolicy: Awaited<ReturnType<typeof gmailExecutionPolicy>>,
) {
  const keep = Boolean(
    input.callerJudges &&
    prior?.classification &&
    prior.status !== "excluded" &&
    prior.status !== "deleted" &&
    !(prior.classification === "uncertain" && prior.contentClearedAt),
  );
  return {
    // A decided Email keeps its policy and search ownership: marking it a
    // member-search match would let search expiry dispose its retained content.
    executionPolicy: (keep && prior?.executionPolicy) || executionPolicy,
    memberSearch: keep
      ? prior?.searchOrigin === "member_search"
      : input.callerJudges,
    replay: keep
      ? (unchangedRetainedOutcome(prior) ?? { kind: "skipped" as const })
      : null,
  };
}

async function acquireEligible(
  db: Database,
  provider: GmailProvider,
  input: IngestInput,
  message: GmailMessage,
  identity: MessageIdentity,
  storage: OrderMailAttachmentStorage,
  executionPolicy: Awaited<ReturnType<typeof gmailExecutionPolicy>>,
  prior: PriorMessage,
): Promise<GmailAcquisitionOutcome> {
  const normalized = normalizeMessage(identity.mailboxId, message);
  const checksum = await originalChecksum(normalized);
  if (await deferClassificationRefresh(db, executionPolicy, prior))
    return { kind: "skipped" };
  if (prior?.classificationVersion === HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION)
    return { kind: "blocked" };
  const unchanged =
    !input.reclassify && unchangedClassification(prior, checksum);
  const search = memberSearchOwnership(input, prior, executionPolicy);
  const publication = {
    ...identity,
    runId: input.runId,
    executionPolicy,
    expected: prior,
  };
  const metadata = {
    ledgerPartyId: input.ledgerPartyId,
    mail: normalized.mail,
    checksum,
    executionPolicy: search.executionPolicy,
    memberSearch: search.memberSearch,
  };
  const replay =
    search.replay ?? (unchanged ? unchangedRetainedOutcome(prior) : null);
  if (replay)
    return (
      (await publishGmailEvidence<GmailAcquisitionOutcome>(
        db,
        publication,
        async (tx) => {
          await saveMailboxMetadata(tx, metadata);
          return replay;
        },
      )) ?? { kind: "skipped" }
    );
  let triageCall: GmailClassificationCall | null = null;
  let relevanceCall: GmailClassificationCall | null = null;
  const ports = routingPorts(db, input, (call) => {
    if (call.operation === "mailbox-triage") triageCall = call;
    else if (call.operation === "mailbox-relevance") relevanceCall = call;
  });
  const transientAttachments = new Map<string, string>();
  const decision = await classifyMessage(
    unchanged ? prior : null,
    input.callerJudges
      ? async () => ({
          classification: "uncertain",
          stage: "rule",
          reason: "Found by a member's search; the caller decides",
        })
      : () => routeGmailMessage(message, normalized, ports.triage),
    !relevanceModelRuns(input, executionPolicy)
      ? null
      : () =>
          interpretMailRelevance(
            provider,
            normalized,
            ports.relevance,
            gmailOriginalComplete(message, normalized),
            (sourceKey, encoded) =>
              transientAttachments.set(sourceKey, encoded),
          ),
  );
  if (
    await deferClassificationRefresh(
      db,
      executionPolicy,
      await readEmail(db, identity),
    )
  )
    return { kind: "skipped" };
  const retain = retainResearchOriginal(
    decision.classification,
    normalized,
    transientAttachments,
  );
  let uploadKeys: ReadonlyMap<string, string> = new Map();
  if (retain)
    uploadKeys = await stageGmailAttachments(
      db,
      provider,
      identity,
      normalized,
      prior?.orderMailId ?? null,
      transientAttachments,
    );
  const createdKeys = new Set<string>();
  let committed = false;
  try {
    return (
      (await publishGmailEvidence<GmailAcquisitionOutcome>(
        db,
        publication,
        async (tx, current) => {
          await runAfterCommit(tx, async () => {
            committed = true;
          });
          const known = current?.orderMailId
            ? await getDb(tx)
                .select({ key: orderMailAttachment.pendingObjectKey })
                .from(orderMailAttachment)
                .where(eq(orderMailAttachment.orderMailId, current.orderMailId))
            : [];
          const protectedKeys = new Set(
            known.flatMap(({ key }) => (key ? [key] : [])),
          );
          const publicationStorage: OrderMailAttachmentStorage = {
            ...storage,
            put: async (key, bytes, contentType) => {
              if (!protectedKeys.has(key)) createdKeys.add(key);
              await storage.put(key, bytes, contentType);
            },
          };
          await saveMailboxMetadata(tx, metadata);
          await observeClassification(
            tx,
            input,
            identity,
            await readEmail(tx, identity),
            checksum,
            decision,
            unchanged,
            classificationCallFor(decision.stage, triageCall, relevanceCall),
          );
          const reclassified =
            input.reclassify && current
              ? await reclassifyPublication(tx, current, decision, retain)
              : null;
          if (reclassified) return reclassified;
          const recorded = {
            classificationStage: decision.stage,
            classificationReason: decision.reason,
          };
          if (!retain) {
            const protectedOriginal = await clearUnrelatedOriginal(
              tx,
              identity,
              publicationStorage,
            );
            if (protectedOriginal)
              return protectOriginalOutcome(
                tx,
                identity,
                protectedOriginal,
                current,
              );
            await saveEmail(tx, {
              ...identity,
              ...recorded,
              checksum,
              classification: decision.classification,
              status:
                decision.classification === "unrelated"
                  ? "completed"
                  : "blocked",
            });
            return {
              kind:
                decision.classification === "unrelated"
                  ? "unrelated"
                  : "blocked",
            };
          }
          // Routing and retained bytes publish together; failed uploads leave the prior source intact.
          await saveEmail(tx, {
            ...identity,
            ...recorded,
            checksum,
            classification: decision.classification,
            status: "pending",
            orderMailId: current?.orderMailId,
          });
          const orderMailId = await retainOriginal(
            tx,
            identity,
            normalized,
            checksum,
            publicationStorage,
            transientAttachments,
            uploadKeys,
          );
          await saveEmail(tx, {
            ...identity,
            ...recorded,
            checksum,
            classification: decision.classification,
            status: "pending",
            orderMailId,
          });
          await getDb(tx)
            .update(emailTable)
            .set({ contentClearedAt: null })
            .where(eq(emailTable.orderMailId, orderMailId));
          return { kind: "saved", orderMailId };
        },
      )) ?? { kind: "skipped" }
    );
  } catch (error) {
    if (committed) throw error;
    return cleanNewGmailKeys(
      createdKeys,
      storage,
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error }),
    );
  }
}

async function relatedEmailPreview(
  db: Database,
  input: IngestInput,
  messageId: string,
  executionPolicy: Awaited<ReturnType<typeof gmailExecutionPolicy>>,
) {
  const email = await readEmail(db, { ...input, messageId });
  if (
    !email ||
    email.classification !== "related" ||
    !emailCandidateSource.shape.checksum.safeParse(email.checksum).success ||
    (await deferClassificationRefresh(db, executionPolicy, email))
  )
    return null;
  const preview = await extractEmailCandidatePreview(
    db,
    {
      emailId: email.id,
      ledgerPartyId: input.ledgerPartyId,
      runId: input.runId,
    },
    { choose: input.candidateChoice },
  );
  const result = await publishGmailEvidence(
    db,
    {
      ledgerPartyId: input.ledgerPartyId,
      mailboxId: input.mailboxId,
      messageId,
      runId: input.runId,
      executionPolicy,
      expected: email,
    },
    async (tx) => {
      await recordEmailCandidateObservation(tx, { emailId: email.id, preview });
      return { emailId: email.id, preview };
    },
  );
  if (result) await input.onCandidatePreview?.(result);
  return result;
}

/** Sequential transient routing precedes all original-content and attachment writes. */
async function reportAcquisitionProgress(input: IngestInput, handled: number) {
  await input.onMessage?.(handled);
}

export async function ingestGmailMessages(
  db: Database,
  provider: GmailProvider,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageIds: readonly string[];
    triage?: MailTriage;
    relevance?: MailRelevance;
    candidateChoice?: EmailCandidateChoice;
    onCandidatePreview?: (
      value: NonNullable<Awaited<ReturnType<typeof relatedEmailPreview>>>,
    ) => Promise<void>;
    runId?: string;
    /** Rules only, no paid classification: the caller judges each message. */
    callerJudges?: boolean;
    /**
     * A member's Reclassify: rerun every stage, including the relevance model,
     * and publish through `reclassifyPublication`.
     */
    reclassify?: boolean;
    storage?: OrderMailAttachmentStorage;
    onMessage?: (handled: number) => Promise<void>;
  },
): Promise<GmailIngestOutcome> {
  if (!input.mailboxId.trim() || input.mailboxId === "me")
    throw new Error("A stable Google account id is required");
  const storage = input.storage ?? productionOrderMailAttachmentStorage;
  const executionPolicy = input.callerJudges
    ? "classification_only"
    : await gmailExecutionPolicy(db, input.runId, input);
  const outcome: GmailIngestOutcome = {
    saved: [],
    orderMailIds: [],
    deleted: [],
    excluded: [],
    unrelated: [],
    blocked: [],
    kept: [],
    confirmed: [],
    candidatePreviews: [],
  };
  let handled = 0;
  for (const messageId of new Set(input.messageIds)) {
    const identity = {
      ledgerPartyId: input.ledgerPartyId,
      mailboxId: input.mailboxId,
      messageId,
    };
    const beforeFetch = await readEmail(db, identity);
    if (await deferClassificationRefresh(db, executionPolicy, beforeFetch)) {
      handled += 1;
      await reportAcquisitionProgress(input, handled);
      continue;
    }
    const fetched = await fetchObservedMessage(
      db,
      provider,
      identity,
      input.runId,
    );
    const message = fetched.message;
    if (message && message.id !== messageId)
      throw new Error("Gmail fetched a different message identity");
    const removed = !message
      ? "deleted"
      : message.labelIds?.some((label) => label === "SPAM" || label === "TRASH")
        ? "excluded"
        : null;
    if (removed) {
      const published = await publishGmailEvidence(
        db,
        {
          ...identity,
          runId: input.runId,
          executionPolicy,
          expected: beforeFetch,
        },
        async (tx) => {
          if (fetched.missing)
            await recordEmailRetrievalFailure(tx, {
              ...identity,
              runId: input.runId,
              httpStatus: fetched.missing.status,
              error: fetched.missing.message,
            });
          if (message) {
            const normalized = normalizeMessage(input.mailboxId, message);
            const search = memberSearchOwnership(
              input,
              beforeFetch,
              executionPolicy,
            );
            await saveMailboxMetadata(tx, {
              ledgerPartyId: input.ledgerPartyId,
              mail: normalized.mail,
              checksum: await originalChecksum(normalized),
              executionPolicy: search.executionPolicy,
              memberSearch: search.memberSearch,
            });
          }
          await markEmailRemoved(tx, { ...identity, status: removed });
          return true;
        },
      );
      if (published) outcome[removed].push(messageId);
    } else if (message) {
      if (input.runId)
        await claimRunExecution(db, runEntityId.parse(input.runId), {
          kind: "candidate",
          mailboxId: input.mailboxId,
          messageId,
        });
      const result = await acquireEligible(
        db,
        provider,
        input,
        message,
        identity,
        storage,
        executionPolicy,
        beforeFetch,
      );
      if (result.kind === "saved") {
        const preview = await relatedEmailPreview(
          db,
          input,
          messageId,
          executionPolicy,
        );
        if (
          !(await deferClassificationRefresh(
            db,
            executionPolicy,
            await readEmail(db, identity),
          ))
        ) {
          outcome.saved.push(messageId);
          outcome.orderMailIds.push(result.orderMailId);
          if (preview) outcome.candidatePreviews.push(preview);
        }
      } else recordUnsavedOutcome(outcome, messageId, result);
    }
    handled += 1;
    await reportAcquisitionProgress(input, handled);
  }
  return outcome;
}
