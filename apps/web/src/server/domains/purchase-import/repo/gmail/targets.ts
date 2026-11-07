import { parseBankDescriptor } from "@cubby/schemas/financial-transaction-fields";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import type { SenderAttribution } from "@cubby/schemas/mail-coverage";
import type { MailboxScopedQuery } from "@cubby/schemas/mailbox-research";
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { senderAddress, distinctSenderDomain } from "~/lib/vendor/domains";
import { account } from "~/server/db/auth.schema";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  ledgerParty,
  email,
  vendor,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  run,
} from "~/server/db/retained-tables";
import { readSenderAttributions } from "~/server/domains/purchase-import/repo/sender-attribution-read";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";

import { vendorSearchTerms } from "./vendor-identity";
import { vendorMailQueries } from "./vendor-mail-scope";

export type GmailSyncTarget = {
  ledgerPartyId: string;
  userId: string;
  mailboxId: string;
  scopedQueries: MailboxScopedQuery[];
};

const discoveryExecution = z.object({
  runId: runEntityId,
  purpose: z.literal("mail_discovery"),
});

/** Fresh automatic admission leaves the mailbox slot for a retained Job's own recovery claim. */
export async function mailDiscoveryRecoveryWakeAt(
  db: Database,
  target: Pick<GmailSyncTarget, "ledgerPartyId" | "mailboxId">,
): Promise<Date | null> {
  const successor = alias(run, "discovery_recovery_successor");
  const candidates = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "mail_discovery"),
        eq(run.trigger, "scheduled"),
        eq(run.status, "failed"),
        eq(run.failureCode, "job_failed"),
        eq(
          run.ledgerPartyId,
          parseEntityId("ledgerParty", target.ledgerPartyId),
        ),
        sql`${run.input}->>'mailboxId' = ${target.mailboxId}`,
        sql`${run.input}->>'controlled' IS NULL`,
        notDeleted(run),
        isNull(run.retiredAt),
        notExists(
          getDb(db)
            .select({ id: successor.id })
            .from(successor)
            .where(
              and(
                eq(successor.predecessorRunId, run.id),
                notDeleted(successor),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(run.createdAt), asc(run.id));
  if (!candidates.length) return null;
  const jobs = await readJobs(db, {
    kind: "run.execute",
    keys: candidates.map((candidate) => `run:${candidate.id}`),
    states: ["queued", "retry_wait", "running"],
  });
  for (const candidate of candidates) {
    const job = jobs.find(
      (row) => row.runId === candidate.id && row.key === `run:${candidate.id}`,
    );
    if (!job || !(job.generation > 1 || job.attempts > 0)) continue;
    const execution = discoveryExecution.safeParse(job.input);
    if (!execution.success || execution.data.runId !== candidate.id) continue;
    if (job.state === "running") {
      if (job.leaseExpiresAt) return job.leaseExpiresAt;
      continue;
    }
    return job.availableAt;
  }
  return null;
}

/**
 * Members whose login has connected Google, one row per mailbox: the
 * mailboxes a scheduled discovery pass reads. A member who never connected
 * Gmail gets no pass (and no failing Run) until they do.
 */
export const listMemberMailboxes = (db: Database) =>
  getDb(db)
    .selectDistinct({
      ledgerPartyId: ledgerParty.id,
      memberShortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
      userId: ledgerParty.userId,
      mailboxId: account.accountId,
    })
    .from(ledgerParty)
    .innerJoin(
      account,
      and(
        eq(account.userId, ledgerParty.userId),
        eq(account.providerId, "google"),
      ),
    )
    .where(and(isNotNull(ledgerParty.userId), notDeleted(ledgerParty)))
    .orderBy(ledgerParty.name, account.accountId);

/** Each member mailbox with the targeted searches discovery runs in it. */
export async function listGmailSyncTargets(
  db: Database,
  knownAttributions?: readonly SenderAttribution[],
): Promise<GmailSyncTarget[]> {
  const attributions = knownAttributions ?? (await readSenderAttributions(db));
  const trustedSenders = new Map(
    attributions.map((row) => [row.sender, row.vendorId]),
  );
  const [members, vendors, charges, receiptSenders] = await Promise.all([
    listMemberMailboxes(db),
    getDb(db)
      .select({
        id: vendor.id,
        shortcode: vendor.shortcode,
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(and(notDeleted(vendor), isNull(vendor.systemKey))),
    getDb(db)
      .select({
        merchant: financialTransaction.merchant,
        rawDescription: financialTransaction.rawDescription,
        ledgerPartyId: financialAccount.ledgerPartyId,
      })
      .from(financialTransaction)
      .innerJoin(
        financialAccount,
        and(
          eq(financialAccount.id, financialTransaction.accountId),
          notDeleted(financialAccount),
        ),
      )
      .leftJoin(
        financialTransactionAllocation,
        and(
          eq(
            financialTransactionAllocation.transactionId,
            financialTransaction.id,
          ),
          notDeleted(financialTransactionAllocation),
        ),
      )
      .where(
        and(
          notDeleted(financialTransaction),
          isNull(financialTransactionAllocation.id),
          or(
            isNotNull(financialTransaction.merchant),
            isNotNull(financialTransaction.rawDescription),
          ),
        ),
      ),
    getDb(db)
      .selectDistinct({
        sender: email.sender,
        mailboxId: email.mailboxId,
        ledgerPartyId: email.ledgerPartyId,
      })
      .from(email)
      .where(and(notDeleted(email), eq(email.classification, "related"))),
  ]);
  const quote = (value: string) => `"${value.replaceAll('"', " ")}"`;
  // One search per distinct merchant (case- and space-insensitive): many
  // unallocated charges share a merchant, and Gmail search ignores case. The
  // query derives from the normalized merchant alone, so allocating one
  // spelling never changes the query text and resets its saved coverage.
  // A charge without a provider merchant searches its cleaned bank
  // descriptor instead (`parseBankDescriptor`), keyed apart from merchants.
  const merchantQueries = (
    rows: readonly { merchant: string | null; rawDescription: string | null }[],
  ) =>
    [
      ...new Set(
        rows.flatMap((charge) => {
          const merchant = charge.merchant
            ?.trim()
            .replace(/\s+/gu, " ")
            .toLowerCase();
          if (merchant) return [`merchant:${merchant}`];
          const descriptor = parseBankDescriptor(
            charge.rawDescription,
          ).merchant;
          return descriptor ? [`descriptor:${descriptor}`] : [];
        }),
      ),
    ].map((key) => ({
      key,
      query: quote(key.slice(key.indexOf(":") + 1)),
    }));
  // A Vendor without a verified sender or website domain waits for research.
  const vendorQueries = vendors.flatMap((row) =>
    vendorMailQueries(
      row.id,
      vendorSearchTerms({
        ...row,
        orderEmailSenders: row.orderEmailSenders.filter(
          (address) =>
            trustedSenders.get(address.trim().toLowerCase()) === row.shortcode,
        ),
      }),
    ),
  );
  return members.flatMap((row) =>
    row.userId && row.mailboxId
      ? [
          {
            ledgerPartyId: row.ledgerPartyId,
            userId: row.userId,
            mailboxId: row.mailboxId,
            scopedQueries: [
              ...vendorQueries,
              ...[
                ...new Set(
                  receiptSenders
                    .filter(
                      (sender) =>
                        sender.mailboxId === row.mailboxId &&
                        sender.ledgerPartyId === row.ledgerPartyId,
                    )
                    .flatMap(({ sender }) => {
                      const address = senderAddress(sender);
                      return address && !distinctSenderDomain(address)
                        ? [address]
                        : [];
                    }),
                ),
              ]
                .sort()
                .map((address) => ({
                  key: `sender:${address}`,
                  query: `from:${quote(address)}`,
                })),
              ...merchantQueries(
                charges.filter(
                  (charge) => charge.ledgerPartyId === row.ledgerPartyId,
                ),
              ),
            ],
          },
        ]
      : [],
  );
}
