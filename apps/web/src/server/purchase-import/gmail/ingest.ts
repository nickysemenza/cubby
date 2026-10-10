import { runEntityId } from "@cubby/schemas/identifiers";
import {
  MAILBOX_RESEARCH_VERSION,
  mailboxClassification,
  type MailboxClassification,
  type MailboxClassificationDecision,
} from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";

import type { Database } from "~/server/db";
import { claimRunExecution } from "~/server/runs/execution-context";

import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { normalizeMessage } from "./normalize";
import {
  clearUnrelatedOriginal,
  readMailboxMessage,
  saveMailboxMessage,
  storeOrderMailAttachment,
  upsertOrderMail,
} from "./persistence";
import { interpretMailRelevance, type MailRelevance } from "./relevance";
import {
  gmailOriginalComplete,
  routeGmailMessage,
  type MailTriage,
} from "./triage";
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
};
type IngestInput = Parameters<typeof ingestGmailMessages>[2];
type MessageIdentity = Pick<IngestInput, "ledgerPartyId" | "mailboxId"> & {
  messageId: string;
};

const fetchMessage = async (
  provider: GmailProvider,
  messageId: string,
): Promise<GmailMessage | null> => {
  try {
    return await provider.getMessage(messageId);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return null;
    throw error;
  }
};

const routingPorts = (db: Database, input: IngestInput) =>
  ({
    triage:
      input.triage ??
      (async (content) => {
        if (!input.runId)
          throw new Error("Gmail triage requires its discovery or search Run");
        const { productionMailTriage } = await import("./triage-model");
        return productionMailTriage(db, input.runId)(content);
      }),
    relevance:
      input.relevance ??
      (async (request) => {
        if (!input.runId)
          throw new Error(
            "Gmail relevance interpretation requires its discovery or search Run",
          );
        const { productionMailRelevance } = await import("./triage-model");
        return productionMailRelevance(db, input.runId)(request);
      }),
  }) satisfies { triage: MailTriage; relevance: MailRelevance };

const originalChecksum = (normalized: GmailNormalizedMessage) =>
  sha256Hex(
    JSON.stringify({
      headers: normalized.mail.headers,
      bodyText: normalized.mail.bodyText,
      bodyHtml: normalized.mail.bodyHtml,
      attachments: normalized.attachments.map(
        ({ sourceKey, filename, mimeType, size }) => ({
          sourceKey,
          filename,
          mimeType,
          size,
        }),
      ),
    }),
  );

const retainOriginal = async (
  db: Database,
  provider: GmailProvider,
  identity: MessageIdentity,
  normalized: GmailNormalizedMessage,
  checksum: string,
  storage: OrderMailAttachmentStorage,
  transientAttachments: ReadonlyMap<string, string>,
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
      fetchData: async () =>
        attachment.dataBase64Url ??
        transientAttachments.get(attachment.sourceKey) ??
        (attachment.attachmentId
          ? (
              await provider.getAttachment(
                identity.messageId,
                attachment.attachmentId,
              )
            ).data
          : undefined),
    });
  return orderMailId;
};

const unchangedClassification = (
  prior: Awaited<ReturnType<typeof readMailboxMessage>>,
  checksum: string,
) =>
  prior?.checksum === checksum &&
  prior.classificationVersion === MAILBOX_RESEARCH_VERSION &&
  prior.status !== "excluded" &&
  prior.status !== "deleted";

// Uncertainty is research work when source content is available; absent bytes
// remain an explicit gap rather than an invented retained original.
const retainResearchOriginal = (
  classification: MailboxClassification,
  normalized: GmailNormalizedMessage,
  transientAttachments: ReadonlyMap<string, string>,
  callerJudges = false,
) =>
  classification === "related" ||
  (classification === "uncertain" &&
    Boolean(
      normalized.mail.bodyText?.trim() ||
      normalized.mail.bodyHtml?.trim() ||
      transientAttachments.size ||
      // The caller reads an attachment-only candidate's retained bytes.
      (callerJudges && normalized.attachments.length),
    ));

/**
 * The classification and why: an unchanged message keeps its recorded verdict;
 * otherwise rules and Jev decide, and the relevance model settles uncertainty.
 */
async function classifyMessage(
  prior: Awaited<ReturnType<typeof readMailboxMessage>>,
  route: () => Promise<MailboxClassificationDecision>,
  relevance: (() => ReturnType<typeof interpretMailRelevance>) | null,
): Promise<MailboxClassificationDecision> {
  const decision: MailboxClassificationDecision = prior
    ? {
        classification: mailboxClassification.parse(prior.classification),
        stage: prior.classificationStage ?? "rule",
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

async function acquireEligible(
  db: Database,
  provider: GmailProvider,
  input: IngestInput,
  message: GmailMessage,
  identity: MessageIdentity,
  storage: OrderMailAttachmentStorage,
): Promise<
  | { kind: "saved"; orderMailId: string }
  | { kind: "unrelated" | "blocked" | "skipped" }
> {
  const normalized = normalizeMessage(identity.mailboxId, message);
  const checksum = await originalChecksum(normalized);
  const prior = await readMailboxMessage(db, identity);
  if (prior?.classificationVersion === HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION)
    return { kind: "blocked" };
  const unchanged = unchangedClassification(prior, checksum);

  if (
    unchanged &&
    prior?.orderMailId &&
    ["researching", "completed"].includes(prior.status)
  )
    return prior.status === "completed"
      ? { kind: "skipped" }
      : { kind: "saved", orderMailId: prior.orderMailId };
  const ports = routingPorts(db, input);
  const transientAttachments = new Map<string, string>();
  // A member's own search has no Run to bill: past Spam/Trash, every message
  // is a candidate the caller settles through `mail.resolve`.
  const decision = await classifyMessage(
    unchanged ? prior : null,
    input.callerJudges
      ? async () => ({
          classification: "uncertain",
          stage: "rule",
          reason: "Found by a member's search; the caller decides",
        })
      : () => routeGmailMessage(message, normalized, ports.triage),
    input.callerJudges
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
  const { classification } = decision;
  const recorded = {
    classificationStage: decision.stage,
    classificationReason: decision.reason,
  };
  if (
    !retainResearchOriginal(
      classification,
      normalized,
      transientAttachments,
      input.callerJudges,
    )
  ) {
    const protectedOriginal = await clearUnrelatedOriginal(
      db,
      identity,
      storage,
    );
    if (protectedOriginal) {
      // A negative verdict cannot turn protection into permission to refresh
      // the original bytes or its attachment owners through the positive path.
      if (prior) {
        if (prior.status === "completed") return { kind: "skipped" };
        if (prior.status === "blocked") return { kind: "blocked" };
      } else
        await saveMailboxMessage(db, {
          ...identity,
          ...protectedOriginal,
          classification: "related",
          status: "pending",
        });
      return { kind: "saved", orderMailId: protectedOriginal.orderMailId };
    }
    const status = classification === "unrelated" ? "completed" : "blocked";
    await saveMailboxMessage(db, {
      ...identity,
      ...recorded,
      checksum,
      classification,
      status,
    });
    return { kind: classification === "unrelated" ? "unrelated" : "blocked" };
  }
  // Upload interruption remains pending, so replay finishes bytes before research dispatch.
  await saveMailboxMessage(db, {
    ...identity,
    ...recorded,
    checksum,
    classification,
    status: "pending",
    orderMailId: prior?.orderMailId,
  });
  const orderMailId = await retainOriginal(
    db,
    provider,
    identity,
    normalized,
    checksum,
    storage,
    transientAttachments,
  );
  await saveMailboxMessage(db, {
    ...identity,
    ...recorded,
    checksum,
    classification,
    status: "pending",
    orderMailId,
  });
  return { kind: "saved", orderMailId };
}

/** Sequential transient routing precedes all original-content and attachment writes. */
export async function ingestGmailMessages(
  db: Database,
  provider: GmailProvider,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageIds: readonly string[];
    triage?: MailTriage;
    relevance?: MailRelevance;
    runId?: string;
    /** Rules only, no paid classification: the caller judges each message. */
    callerJudges?: boolean;
    storage?: OrderMailAttachmentStorage;
    onMessage?: (handled: number) => Promise<void>;
  },
): Promise<GmailIngestOutcome> {
  if (!input.mailboxId.trim() || input.mailboxId === "me")
    throw new Error("A stable Google account id is required");
  const storage = input.storage ?? productionOrderMailAttachmentStorage;
  const outcome: GmailIngestOutcome = {
    saved: [],
    orderMailIds: [],
    deleted: [],
    excluded: [],
    unrelated: [],
    blocked: [],
  };
  let handled = 0;
  for (const messageId of new Set(input.messageIds)) {
    const identity = {
      ledgerPartyId: input.ledgerPartyId,
      mailboxId: input.mailboxId,
      messageId,
    };
    const message = await fetchMessage(provider, messageId);
    if (message && message.id !== messageId)
      throw new Error("Gmail fetched a different message identity");
    const removed = !message
      ? "deleted"
      : message.labelIds?.some((label) => label === "SPAM" || label === "TRASH")
        ? "excluded"
        : null;
    if (removed) {
      await saveMailboxMessage(db, {
        ...identity,
        checksum: removed,
        classification: "uncertain",
        status: removed,
      });
      outcome[removed].push(messageId);
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
      );
      if (result.kind === "saved") {
        outcome.saved.push(messageId);
        outcome.orderMailIds.push(result.orderMailId);
      } else if (result.kind !== "skipped")
        outcome[result.kind].push(messageId);
    }
    handled += 1;
    await input.onMessage?.(handled);
  }
  return outcome;
}
