import type { ExecutionAuthorizationRequestedScope } from "@cubby/schemas/execution-authorization";
import {
  mailboxCoverage,
  type MailboxCoverage,
  type MailboxPage,
  type MailboxScopedQuery,
} from "@cubby/schemas/mailbox-research";

import { normalizeHistoryPage } from "./normalize";
import type { GmailProvider } from "./types";

export const GMAIL_PAGE_SIZE = 25;
export const ELIGIBLE_MAIL_QUERY = "-in:spam -in:trash";

/** The later of two Gmail history ids; a cursor never moves backwards. */
export const maxHistoryId = (
  current: string | null,
  candidate: string | undefined,
): string | null => {
  if (!candidate) return current;
  if (!current) return candidate;
  try {
    return BigInt(candidate) > BigInt(current) ? candidate : current;
  } catch {
    return candidate > current ? candidate : current;
  }
};

/** Persist this baseline before calling listGmailPage, including first connection. */
export async function initializeMailboxCoverage(
  provider: GmailProvider,
  scopedQueries: readonly MailboxScopedQuery[],
): Promise<MailboxCoverage> {
  const profile = await provider.getProfile();
  return mailboxCoverage.parse({
    version: 1,
    baselineHistoryId: profile.historyId,
    broad: { pageToken: null, completed: false },
    scoped: [
      ...new Map(
        scopedQueries.map((query) => [
          query.key,
          { ...query, pageToken: null, completed: false },
        ]),
      ).values(),
    ],
    history: {
      historyId: profile.historyId,
      pageToken: null,
      targetHistoryId: null,
    },
    nextLane: "scan",
  });
}

/** New targeted objectives do not reset broad or unchanged query coverage. */
export function mergeMailboxQueries(
  coverage: MailboxCoverage,
  queries: readonly MailboxScopedQuery[],
): MailboxCoverage {
  const next = mailboxCoverage.parse(coverage);
  const byKey = new Map(next.scoped.map((query) => [query.key, query]));
  for (const query of queries) {
    const prior = byKey.get(query.key);
    if (!prior || prior.query !== query.query)
      byKey.set(query.key, { ...query, pageToken: null, completed: false });
  }
  next.scoped = [...byKey.values()];
  return next;
}

/** One provider page. The caller durably commits nextCoverage after processing it. */
export async function listGmailPage(
  provider: GmailProvider,
  mailboxId: string,
  startCoverage: MailboxCoverage,
  discovery: ExecutionAuthorizationRequestedScope["discovery"] = "new_mail",
): Promise<MailboxPage> {
  if (!mailboxId.trim() || mailboxId === "me")
    throw new Error("A stable Google account id is required");
  const nextCoverage = mailboxCoverage.parse(startCoverage);
  const scoped = nextCoverage.scoped.find((query) => !query.completed);
  const scanPending =
    Boolean(scoped) ||
    (discovery === "all_history" && !nextCoverage.broad.completed);
  if (discovery !== "new_mail") {
    if (!scanPending)
      return { messageIds: [], events: [], startCoverage, nextCoverage };
    const position = scoped ?? nextCoverage.broad;
    const query = scoped
      ? `(${scoped.query}) ${ELIGIBLE_MAIL_QUERY}`
      : ELIGIBLE_MAIL_QUERY;
    const request: Parameters<GmailProvider["listMessages"]>[0] = {
      query,
      maxResults: GMAIL_PAGE_SIZE,
    };
    if (position.pageToken) request.pageToken = position.pageToken;
    const page = await provider.listMessages(request);
    position.pageToken = page.nextPageToken ?? null;
    position.completed = !page.nextPageToken;
    nextCoverage.nextLane = "history";
    return {
      messageIds: [
        ...new Set(
          (page.messages ?? []).map((message) => message.id).filter(Boolean),
        ),
      ],
      events: [],
      startCoverage,
      nextCoverage,
    };
  }
  const position = nextCoverage.history;
  const request: Parameters<GmailProvider["listHistory"]>[0] = {
    startHistoryId: position.historyId,
    maxResults: GMAIL_PAGE_SIZE,
  };
  if (position.pageToken) request.pageToken = position.pageToken;
  const page = await provider.listHistory(request);
  position.targetHistoryId = maxHistoryId(
    position.targetHistoryId ?? position.historyId,
    page.historyId,
  );
  position.pageToken = page.nextPageToken ?? null;
  if (!position.pageToken) {
    position.historyId = position.targetHistoryId ?? position.historyId;
    position.targetHistoryId = null;
  }
  // Finish a paginated history catch-up before continuing old history.
  nextCoverage.nextLane = position.pageToken ? "history" : "scan";
  const events = normalizeHistoryPage(mailboxId, page).map((event) => ({
    ...event,
    labelIds: [...event.labelIds],
  }));
  return {
    messageIds: [
      ...new Set(
        events
          .filter((event) => event.kind !== "message_deleted")
          .map((event) => event.messageId),
      ),
    ],
    events,
    startCoverage,
    nextCoverage,
  };
}
