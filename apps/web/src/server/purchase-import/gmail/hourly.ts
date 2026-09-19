import type { Database } from "~/server/db";

import {
  advanceGmailCursor,
  loadGmailCursor,
  persistGmailSyncResult,
} from "./persistence";
import { syncGmailMailbox, type GmailSyncOptions } from "./sync";
import type { GmailOrderMailAttachment, GmailProvider } from "./types";
import type { GmailBootstrapInput, GmailSyncResult } from "./types";

export type GmailSyncTarget = {
  ledgerPartyId: string;
  userId: string;
  mailboxId: string;
  bootstrap: GmailBootstrapInput;
};

export type GmailHourlySyncOptions = {
  db: Database;
  listTargets: () => Promise<readonly GmailSyncTarget[]>;
  providerForUser: (userId: string) => Promise<GmailProvider>;
  now?: () => Date;
  sync?: (
    provider: GmailProvider,
    options: GmailSyncOptions,
  ) => Promise<GmailSyncResult>;
  maxResults?: number;
  includeAttachmentData?: boolean;
  loadCursor?: typeof loadGmailCursor;
  persist?: typeof persistGmailSyncResult;
  advanceCursor?: typeof advanceGmailCursor;
  processMessages?: (
    db: Database,
    messageIds: readonly string[],
    attachments: readonly GmailOrderMailAttachment[],
  ) => Promise<number>;
};

export type GmailHourlySyncSummary = {
  attempted: number;
  succeeded: number;
  failures: readonly {
    ledgerPartyId: string;
    userId: string;
    error: string;
  }[];
};

/**
 * One sequential pass is intentional: cron invocations can overlap, while
 * each cursor transaction remains idempotent and Gmail API pressure stays
 * bounded. The cf-server cron hook may log the returned failure summary.
 */
export const runGmailHourlySync = async (
  options: GmailHourlySyncOptions,
): Promise<GmailHourlySyncSummary> => {
  const targets = [...(await options.listTargets())].sort((a, b) =>
    a.ledgerPartyId.localeCompare(b.ledgerPartyId),
  );
  const failures: Array<GmailHourlySyncSummary["failures"][number]> = [];
  let succeeded = 0;
  const sync = options.sync ?? syncGmailMailbox;
  const loadCursor = options.loadCursor ?? loadGmailCursor;
  const persist = options.persist ?? persistGmailSyncResult;
  const advanceCursor = options.advanceCursor ?? advanceGmailCursor;

  for (const target of targets) {
    try {
      const cursor = await loadCursor(options.db, target);
      const provider = await options.providerForUser(target.userId);
      const result = await sync(provider, {
        mailboxId: target.mailboxId,
        cursor,
        bootstrap: target.bootstrap,
        maxResults: options.maxResults,
        includeAttachmentData: options.includeAttachmentData,
      });
      const polledAt = (options.now ?? (() => new Date()))();
      const persisted = await persist(options.db, {
        ledgerPartyId: target.ledgerPartyId,
        polledAt,
        advanceCursor: !options.processMessages,
        result,
      });
      await options.processMessages?.(
        options.db,
        persisted.messageIds,
        result.attachments,
      );
      if (options.processMessages) {
        await advanceCursor(options.db, {
          ledgerPartyId: target.ledgerPartyId,
          historyId: result.cursor.historyId,
          polledAt,
        });
      }
      succeeded += 1;
    } catch (error) {
      failures.push({
        ledgerPartyId: target.ledgerPartyId,
        userId: target.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attempted: targets.length, succeeded, failures };
};
