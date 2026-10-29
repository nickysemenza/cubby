import {
  mailboxCoverage,
  type MailboxCoverage,
  type MailboxPage,
  type MailboxScopedQuery,
} from "@cubby/schemas/mailbox-research";

import { normalizeHistoryPage } from "~/server/domains/purchase-import/repo/gmail/normalize";
import type { GmailProvider } from "~/server/domains/purchase-import/repo/gmail/types";
import { eligibleMailSearchQuery } from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";

export const GMAIL_PAGE_SIZE = 25;

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
          { ...query, pageToken: null, completed: false, messageCount: 0 },
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

/**
 * The coverage to commit for a processed page: a targeted page adds the
 * Emails it retained to its search and stamps the search's finish time.
 * Deterministic but for `now`, so a replayed page commits the same counts.
 */
export function creditScopedPage(
  page: Pick<MailboxPage, "nextCoverage" | "scopedKey"> &
    Partial<Pick<MailboxPage, "messageIds">>,
  retained: number,
  now: Date,
  runId?: MailboxCoverage["scoped"][number]["runId"],
): MailboxCoverage {
  const next = mailboxCoverage.parse(page.nextCoverage);
  const position = next.scoped.find((query) => query.key === page.scopedKey);
  if (!position) return next;
  if (runId) position.runId = runId;
  position.emailCount = (position.emailCount ?? 0) + retained;
  if (position.messageCount !== undefined && page.messageIds)
    position.messageCount += page.messageIds.length;
  if (position.completed) position.completedAt = now.toISOString();
  // Re-parse so key order matches a stored read; the checkpoint compares JSON.
  return mailboxCoverage.parse(next);
}

/** Preserve intervening lanes while refusing to rewind this page's own position. */
export function rebaseMailboxPage({
  page,
  coverage,
  restoreScopedQuery,
}: {
  page: MailboxPage;
  coverage: MailboxCoverage;
  restoreScopedQuery: boolean;
}): MailboxPage | null {
  if (coverage.baselineHistoryId !== page.startCoverage.baselineHistoryId)
    return null;
  const next = mailboxCoverage.parse(coverage);
  if (page.scopedKey) {
    const before = page.startCoverage.scoped.find(
      (query) => query.key === page.scopedKey,
    );
    const after = page.nextCoverage.scoped.find(
      (query) => query.key === page.scopedKey,
    );
    const current = next.scoped.find((query) => query.key === page.scopedKey);
    if (
      !before ||
      !after ||
      (current
        ? JSON.stringify(current) !== JSON.stringify(before)
        : !restoreScopedQuery)
    )
      return null;
    // A later unattended pass may prune a stopped control's query. Only its
    // explicit frozen scope may restore it; other query progress stays current.
    next.scoped = current
      ? next.scoped.map((query) =>
          query.key === page.scopedKey ? after : query,
        )
      : [...next.scoped, after];
  } else {
    if (
      JSON.stringify(next.history) !==
      JSON.stringify(page.startCoverage.history)
    )
      return null;
    next.history = page.nextCoverage.history;
  }
  next.nextLane = page.nextCoverage.nextLane;
  return { ...page, startCoverage: coverage, nextCoverage: next };
}

/** One provider page. The caller durably commits nextCoverage after processing it. */
export async function listGmailPage(
  provider: GmailProvider,
  mailboxId: string,
  startCoverage: MailboxCoverage,
  discovery: "new_mail" | "targeted" = "new_mail",
  scopedKeys?: readonly string[],
): Promise<MailboxPage> {
  if (!mailboxId.trim() || mailboxId === "me")
    throw new Error("A stable Google account id is required");
  const nextCoverage = mailboxCoverage.parse(startCoverage);
  if (discovery === "targeted") {
    const position = nextCoverage.scoped.find(
      (query) =>
        !query.completed && (!scopedKeys || scopedKeys.includes(query.key)),
    );
    if (!position)
      return { messageIds: [], events: [], startCoverage, nextCoverage };
    const request: Parameters<GmailProvider["listMessages"]>[0] = {
      query: eligibleMailSearchQuery(position.query),
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
      scopedKey: position.key,
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
