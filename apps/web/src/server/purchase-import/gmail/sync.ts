import { householdDaysAgo } from "~/lib/household-date";

import { normalizeHistoryPage } from "./normalize";
import {
  GmailApiError,
  type GmailBootstrapInput,
  type GmailBootstrapPlan,
  type GmailOrderMailEvent,
  type GmailProvider,
} from "./types";

const historyNumber = (value: string): bigint | null => {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

/** The later of two Gmail history ids; a cursor never moves backwards. */
export const maxHistoryId = (
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
  // Gmail reads a bare `after:` date as Pacific midnight: a household day.
  const knownStart = earliestUnresolvedHuntAt
    ? householdDaysAgo(7, earliestUnresolvedHuntAt)
    : householdDaysAgo(lookbackDays, now);
  const unknownStart = householdDaysAgo(lookbackDays, now);
  return {
    knownSenderQueries: uniqueSenders.map(
      (sender) => `from:${sender} after:${knownStart}`,
    ),
    unknownOrderQuery: `after:${unknownStart}`,
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

/**
 * What changed in a mailbox since `historyId`, as message ids and history
 * events only: no message body or attachment is fetched here, so listing a
 * large backlog costs ids, not bytes. A first sync (no cursor) or an expired
 * cursor (`history.list` 404) lists the bootstrap queries instead, from a
 * profile baseline captured before scanning so mail arriving mid-scan is
 * picked up by the next pass rather than skipped.
 */
export type GmailChanges = {
  mode: "bootstrap" | "full_resync" | "incremental";
  /** Where the cursor moves once every listed message is processed. */
  targetHistoryId: string | null;
  messageIds: string[];
  events: GmailOrderMailEvent[];
};

const listBootstrap = async (
  provider: GmailProvider,
  plan: GmailBootstrapPlan,
  maxResults: number,
  mode: "bootstrap" | "full_resync",
): Promise<GmailChanges> => {
  const profile = await provider.getProfile();
  const ids: string[] = [];
  for (const query of [...plan.knownSenderQueries, plan.unknownOrderQuery])
    ids.push(...(await listMessageIds(provider, query, maxResults)));
  return {
    mode,
    targetHistoryId: profile.historyId,
    messageIds: sortedUnique(ids),
    events: [],
  };
};

export const listGmailChanges = async (
  provider: GmailProvider,
  options: {
    mailboxId: string;
    historyId: string | null;
    bootstrap: GmailBootstrapInput;
    maxResults?: number;
  },
): Promise<GmailChanges> => {
  if (!options.mailboxId.trim())
    throw new Error("Gmail mailbox id is required");
  const maxResults = options.maxResults ?? 100;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error("Gmail maxResults must be between 1 and 500");
  }
  const plan = buildBootstrapPlan(options.bootstrap);
  if (!options.historyId)
    return listBootstrap(provider, plan, maxResults, "bootstrap");

  const events: GmailOrderMailEvent[] = [];
  let observedHistoryId: string | null = options.historyId;
  let pageToken: string | undefined;
  try {
    do {
      const request: Parameters<GmailProvider["listHistory"]>[0] = {
        startHistoryId: options.historyId,
        maxResults,
      };
      if (pageToken) request.pageToken = pageToken;
      const page = await provider.listHistory(request);
      observedHistoryId = maxHistoryId(observedHistoryId, page.historyId);
      events.push(...normalizeHistoryPage(options.mailboxId, page));
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    return listBootstrap(provider, plan, maxResults, "full_resync");
  }
  const uniqueEvents = [
    ...new Map(events.map((event) => [event.sourceKey, event])).values(),
  ].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return {
    mode: "incremental",
    targetHistoryId: observedHistoryId,
    messageIds: sortedUnique(
      uniqueEvents
        .filter((event) => event.kind !== "message_deleted")
        .map((event) => event.messageId),
    ),
    events: uniqueEvents,
  };
};
