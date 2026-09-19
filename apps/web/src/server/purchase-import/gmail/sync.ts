import {
  mergeAttachmentPayload,
  normalizeHistoryPage,
  normalizeMessage,
} from "./normalize";
import {
  GmailApiError,
  type GmailBootstrapInput,
  type GmailBootstrapPlan,
  type GmailCursor,
  type GmailOrderMailAttachment,
  type GmailProvider,
  type GmailSyncReason,
  type GmailSyncResult,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

const historyNumber = (value: string): bigint | null => {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const maxHistoryId = (
  current: string | null,
  candidate: string | undefined,
): string | null => {
  if (!candidate) return current;
  if (!current) return candidate;
  const left = historyNumber(current);
  const right = historyNumber(candidate);
  if (left !== null && right !== null)
    return right > left ? candidate : current;
  return candidate > current ? candidate : current;
};

/**
 * Advance only from a completed page sequence. Callers should persist the
 * returned cursor after all messages and attachment fetches succeed.
 */
export const advanceGmailCursor = (
  cursor: GmailCursor,
  observedHistoryId: string | undefined,
): GmailCursor => ({
  historyId: maxHistoryId(cursor.historyId, observedHistoryId),
});

const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

const subtractDays = (value: Date, days: number): Date =>
  new Date(value.getTime() - days * DAY_MS);

/**
 * The plan is deliberately query-shaped, not Gmail-message-shaped. The
 * caller can persist it with the hunt that caused the sync and rerun it
 * without changing the source keys.
 */
export const buildBootstrapPlan = ({
  knownSenders,
  earliestUnresolvedHuntAt = null,
  now = new Date(),
  lookbackDays = 30,
}: GmailBootstrapInput): GmailBootstrapPlan => {
  if (
    !Number.isInteger(lookbackDays) ||
    lookbackDays < 1 ||
    lookbackDays > 365
  ) {
    throw new Error("Gmail bootstrap lookbackDays must be between 1 and 365");
  }
  const uniqueSenders = [
    ...new Set(
      knownSenders
        .map((sender) => sender.trim().toLowerCase())
        .filter((sender) => sender.length > 0),
    ),
  ].sort();
  const knownStart = earliestUnresolvedHuntAt
    ? subtractDays(earliestUnresolvedHuntAt, 7)
    : subtractDays(now, lookbackDays);
  const unknownStart = subtractDays(now, lookbackDays);
  return {
    knownSenderQueries: uniqueSenders.map(
      (sender) => `from:${sender} after:${dateOnly(knownStart)}`,
    ),
    unknownOrderQuery: `after:${dateOnly(unknownStart)}`,
  };
};

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b));

const listMessageIds = async (
  provider: GmailProvider,
  query: string,
  maxResults: number,
): Promise<string[]> => {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const request: Parameters<GmailProvider["listMessages"]>[0] = {
      query,
      maxResults,
    };
    if (pageToken) request.pageToken = pageToken;
    const page = await provider.listMessages(request);
    for (const message of page.messages ?? []) {
      if (message.id.trim()) ids.push(message.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
};

const loadMessages = async (
  provider: GmailProvider,
  mailboxId: string,
  messageIds: Iterable<string>,
  includeAttachmentData: boolean,
): Promise<{
  messages: GmailSyncResult["messages"];
  attachments: GmailSyncResult["attachments"];
}> => {
  const normalized = [];
  for (const messageId of sortedUnique(messageIds)) {
    const message = normalizeMessage(
      mailboxId,
      await provider.getMessage(messageId),
    );
    const attachments: GmailOrderMailAttachment[] = [];
    for (const attachment of message.attachments) {
      if (includeAttachmentData && attachment.attachmentId) {
        attachments.push(
          mergeAttachmentPayload(
            attachment,
            await provider.getAttachment(messageId, attachment.attachmentId),
          ),
        );
      } else {
        attachments.push(attachment);
      }
    }
    normalized.push({ mail: message.mail, attachments });
  }
  return {
    messages: normalized.map(({ mail }) => mail),
    attachments: normalized
      .flatMap(({ attachments }) => attachments)
      .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
  };
};

const fullResync = async (
  provider: GmailProvider,
  options: {
    mailboxId: string;
    plan: GmailBootstrapPlan;
    maxResults: number;
    includeAttachmentData: boolean;
    reason: Extract<GmailSyncReason, "first_sync" | "history_expired">;
  },
): Promise<GmailSyncResult> => {
  // Capture the baseline before scanning pages. Changes arriving during the
  // scan are picked up by the next history sync instead of being skipped.
  const profile = await provider.getProfile();
  const queries = [
    ...options.plan.knownSenderQueries,
    options.plan.unknownOrderQuery,
  ];
  const ids: string[] = [];
  for (const query of queries) {
    ids.push(...(await listMessageIds(provider, query, options.maxResults)));
  }
  const loaded = await loadMessages(
    provider,
    options.mailboxId,
    ids,
    options.includeAttachmentData,
  );
  return {
    mode: options.reason === "first_sync" ? "bootstrap" : "full_resync",
    reason: options.reason,
    cursor: { historyId: profile.historyId },
    messages: loaded.messages,
    events: [],
    attachments: loaded.attachments,
  };
};

export type GmailSyncOptions = {
  mailboxId: string;
  cursor: GmailCursor;
  bootstrap: GmailBootstrapInput;
  maxResults?: number;
  includeAttachmentData?: boolean;
};

export const syncGmailMailbox = async (
  provider: GmailProvider,
  options: GmailSyncOptions,
): Promise<GmailSyncResult> => {
  if (!options.mailboxId.trim())
    throw new Error("Gmail mailbox id is required");
  const maxResults = options.maxResults ?? 100;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error("Gmail maxResults must be between 1 and 500");
  }
  const includeAttachmentData = options.includeAttachmentData ?? false;
  const plan = buildBootstrapPlan(options.bootstrap);

  if (!options.cursor.historyId) {
    return await fullResync(provider, {
      mailboxId: options.mailboxId,
      plan,
      maxResults,
      includeAttachmentData,
      reason: "first_sync",
    });
  }

  try {
    let pageToken: string | undefined;
    let observedHistoryId: string | undefined;
    const events = [];
    do {
      const request: Parameters<GmailProvider["listHistory"]>[0] = {
        startHistoryId: options.cursor.historyId,
        maxResults,
      };
      if (pageToken) request.pageToken = pageToken;
      const page = await provider.listHistory(request);
      observedHistoryId =
        maxHistoryId(observedHistoryId ?? null, page.historyId) ??
        observedHistoryId;
      events.push(...normalizeHistoryPage(options.mailboxId, page));
      pageToken = page.nextPageToken;
    } while (pageToken);

    const uniqueEvents = [
      ...new Map(events.map((event) => [event.sourceKey, event])).values(),
    ].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    const messageIds = uniqueEvents
      .filter((event) => event.kind !== "message_deleted")
      .map((event) => event.messageId);
    const loaded = await loadMessages(
      provider,
      options.mailboxId,
      messageIds,
      includeAttachmentData,
    );
    return {
      mode: "incremental",
      reason: "incremental",
      cursor: advanceGmailCursor(options.cursor, observedHistoryId),
      messages: loaded.messages,
      events: uniqueEvents,
      attachments: loaded.attachments,
    };
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    return await fullResync(provider, {
      mailboxId: options.mailboxId,
      plan,
      maxResults,
      includeAttachmentData,
      reason: "history_expired",
    });
  }
};
