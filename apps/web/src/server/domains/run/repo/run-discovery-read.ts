import type { LedgerPartyId, UserId } from "@cubby/schemas/identifiers";
import { runShortcode } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  summarizeDiscoveryProgress,
  summarizeMailboxCoverage,
  summarizeQueryList,
} from "@cubby/schemas/mailbox-research";
import { and, eq, sql } from "drizzle-orm";

import { listAiUsageForRun } from "~/server/ai/repo/ai-usage";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { aiUsage, run } from "~/server/db/schema";
import { readDiscoveryEmailAudit } from "~/server/domains/email/repo/discovery-email-audit";
import { loadGmailCursor } from "~/server/domains/purchase-import/repo/gmail/persistence";

type DiscoveryOwner = { userId: UserId; ledgerPartyId: LedgerPartyId };

/** A Workflow's persisted read needs its member owner, never an agent session. */
export async function findOwnedMailDiscovery(
  db: Database,
  publicId: string,
  owner: DiscoveryOwner | null,
) {
  const database = getDb(db);
  const [row] = await database
    .select()
    .from(run)
    .where(
      and(eq(run.shortcode, runShortcode.parse(publicId)), notDeleted(run)),
    )
    .limit(1);
  if (row?.purpose !== "mail_discovery") return null;
  if (
    !owner ||
    row.actorUserId !== owner.userId ||
    row.ledgerPartyId !== owner.ledgerPartyId
  )
    throw new Error("Discovery Run does not belong to this member");
  return row;
}

export async function loadMailDiscoveryRead(
  db: Database,
  publicId: string,
  owner: DiscoveryOwner | null,
  page: { cursor: number; limit: number } = { cursor: 0, limit: 50 },
) {
  const row = await findOwnedMailDiscovery(db, publicId, owner);
  if (!row) return null;
  if (!owner) throw new Error("Discovery Run has no member owner");
  const database = getDb(db);
  const input = mailboxDiscoveryInput
    .extend({
      scopedQueries: mailboxDiscoveryInput.shape.scopedQueries.optional(),
      executionPolicy: mailboxDiscoveryInput.shape.executionPolicy
        .unwrap()
        .optional(),
    })
    .parse(row.input);
  // Historical omissions are unknown scope, not an empty query list or the
  // current launch policy. Status/findings remain readable without readiness.
  const [mailbox, totals, [counts]] = await Promise.all([
    loadGmailCursor(db, {
      ledgerPartyId: owner.ledgerPartyId,
      mailboxId: input.mailboxId,
    }),
    listAiUsageForRun(db, row.id, { limit: 1 }),
    database
      .select({
        callCount: sql<number>`count(*)::int`,
        retryCount: sql<number>`(count(*) filter (where ${aiUsage.attempt} > 1))::int`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.runId, row.id), notDeleted(aiUsage))),
  ]);
  return {
    emails: await readDiscoveryEmailAudit(
      db,
      row,
      input.mailboxId,
      input.emailAuditVersion === 1 && row.status === "completed",
      page,
    ),
    scope: {
      mailboxId: input.mailboxId,
      scopedQueries: input.scopedQueries
        ? summarizeQueryList(input.scopedQueries)
        : null,
      executionPolicy: input.executionPolicy ?? null,
    },
    checkpoint: row.progress
      ? summarizeDiscoveryProgress(mailboxDiscoveryProgress.parse(row.progress))
      : null,
    mailbox: {
      historyId: mailbox.historyId,
      coverage: mailbox.coverage && summarizeMailboxCoverage(mailbox.coverage),
    },
    failureCode: row.failureCode,
    error: row.dispatchError,
    usage: {
      callCount: counts?.callCount ?? 0,
      retryCount: counts?.retryCount ?? 0,
      standardCost: totals.standardCost,
      chargedCost: totals.chargedCost,
      standardUnpricedCount: totals.standardUnpricedCount,
      chargedUnpricedCount: totals.chargedUnpricedCount,
      savings: totals.savings,
      comparedCalls: totals.comparedCalls,
      count: totals.count,
      billingReasons: totals.billingReasons,
    },
  };
}
