import {
  parseEntityId,
  runShortcode,
  type RunId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  emailStatus,
  mailboxDiscoveryInput,
  type MailboxScopedPosition,
} from "@cubby/schemas/mailbox-research";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import { senderAddress } from "~/lib/vendor/domains";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { email, orderMail, run, vendor } from "~/server/db/retained-tables";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";
import { readMailImportSettings } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { runJobLeaseLive } from "~/server/generic/jobs/repo/job-reads";

type ControlledMailScope = z.infer<typeof mailboxDiscoveryInput> & {
  vendorId: VendorId;
};
/** A new controlled scope never reopens a settled Email or a review stop. */
export const CONTROLLED_MAIL_SOURCE_STATUSES = [
  emailStatus.enum.pending,
  emailStatus.enum.researching,
];
export type ControlledMailRequest = Pick<
  typeof run.$inferSelect,
  "id" | "shortcode" | "status" | "failureCode" | "ledgerPartyId"
>;

type CompletedSearches = Map<string, Map<string, MailboxScopedPosition>>;
type SearchReceipt = Pick<
  typeof run.$inferSelect,
  "vendorId" | "ledgerPartyId" | "input" | "status" | "endedAt"
> & { shortcode?: string };

/** Completed all-history requests prove coverage even after request cursors are pruned. */
export function completedControlledSearches(
  rows: readonly SearchReceipt[],
): CompletedSearches {
  const result: CompletedSearches = new Map();
  for (const row of rows) {
    const input = mailboxDiscoveryInput.safeParse(row.input);
    if (
      !row.vendorId ||
      !row.ledgerPartyId ||
      row.status !== "completed" ||
      !input.success ||
      !input.data.controlled ||
      input.data.controlled.from ||
      input.data.controlled.to
    )
      continue;
    const key = `${row.vendorId}/${row.ledgerPartyId}/${input.data.mailboxId}`;
    const queries = result.get(key) ?? new Map<string, MailboxScopedPosition>();
    for (const query of input.data.scopedQueries) {
      if (!queries.has(query.query))
        queries.set(query.query, {
          ...query,
          pageToken: null,
          completed: true,
          completedAt: row.endedAt?.toISOString(),
          ...(row.shortcode
            ? { runId: runShortcode.parse(row.shortcode) }
            : {}),
        });
    }
    result.set(key, queries);
  }
  return result;
}

export async function readCompletedControlledSearches(
  db: Database,
  vendorIds: readonly VendorId[],
): Promise<CompletedSearches> {
  if (vendorIds.length === 0) return new Map();
  return completedControlledSearches(
    await getDb(db)
      .select({
        shortcode: run.shortcode,
        vendorId: run.vendorId,
        ledgerPartyId: run.ledgerPartyId,
        input: run.input,
        status: run.status,
        endedAt: run.endedAt,
      })
      .from(run)
      .where(
        and(
          eq(run.purpose, "mail_discovery"),
          eq(run.status, "completed"),
          inArray(run.vendorId, [...vendorIds]),
          notDeleted(run),
        ),
      )
      .orderBy(desc(run.endedAt), desc(run.id)),
  );
}

/** The selected Vendor and frozen mailbox/search range follow the child's causal parent. */
export async function controlledMailScopeForRun(
  db: Database,
  runId: RunId,
): Promise<ControlledMailScope | null> {
  const [owner] = await getDb(db)
    .select({
      purpose: run.purpose,
      parentRunId: run.parentRunId,
      vendorId: run.vendorId,
    })
    .from(run)
    .where(and(eq(run.id, runId), notDeleted(run)))
    .limit(1);
  if (owner?.purpose !== "mail_import" || !owner.parentRunId || !owner.vendorId)
    return null;
  const [parent] = await getDb(db)
    .select({ input: run.input, purpose: run.purpose })
    .from(run)
    .where(and(eq(run.id, owner.parentRunId), notDeleted(run)))
    .limit(1);
  const policy = mailboxDiscoveryInput.safeParse(parent?.input);
  return parent?.purpose === "mail_discovery" &&
    policy.success &&
    policy.data.controlled
    ? { ...policy.data, vendorId: owner.vendorId }
    : null;
}

/** Reuse local related originals even when the selected Gmail search already finished. */
export async function retainedControlledMailIds(
  db: Database,
  runId: RunId,
): Promise<string[]> {
  const [owner] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);
  const policy = mailboxDiscoveryInput.safeParse(owner?.input);
  if (
    !owner?.vendorId ||
    !owner.ledgerPartyId ||
    !policy.success ||
    !policy.data.controlled
  )
    return [];
  const [seller] = await getDb(db)
    .select()
    .from(vendor)
    .where(and(eq(vendor.id, owner.vendorId), notDeleted(vendor)))
    .limit(1);
  if (!seller) return [];
  const terms = vendorSearchTerms(seller);
  const { from, to } = policy.data.controlled;
  const sources = await getDb(db)
    .select({
      id: orderMail.id,
      vendorId: orderMail.vendorId,
      sender: email.sender,
      receivedAt: email.receivedAt,
    })
    .from(email)
    .innerJoin(
      orderMail,
      and(
        eq(orderMail.id, email.orderMailId),
        eq(orderMail.rawChecksum, email.checksum),
      ),
    )
    .where(
      and(
        eq(email.ledgerPartyId, owner.ledgerPartyId),
        eq(email.mailboxId, policy.data.mailboxId),
        eq(email.classification, "related"),
        or(
          isNull(email.classificationVersion),
          ne(
            email.classificationVersion,
            HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
          ),
        ),
        notDeleted(email),
        inArray(email.status, CONTROLLED_MAIL_SOURCE_STATUSES),
      ),
    );
  return sources
    .filter((source) => {
      if (source.vendorId && source.vendorId !== owner.vendorId) return false;
      const address = senderAddress(source.sender);
      const matches =
        source.vendorId === owner.vendorId ||
        terms.some((term) =>
          term.includes("@")
            ? address === term
            : address?.endsWith(`@${term}`) || address?.endsWith(`.${term}`),
        );
      if (!matches) return false;
      const date = source.receivedAt
        ? householdLocalDate(source.receivedAt)
        : null;
      return (
        (!from && !to) ||
        Boolean(date && (!from || date >= from) && (!to || date <= to))
      );
    })
    .map((source) => source.id);
}

/** The persisted member request also fences automatic discovery until its selected searches finish. */
export async function findControlledMailImport(
  db: Database,
  mailboxId: string,
): Promise<ControlledMailRequest | null> {
  const [row] = await getDb(db)
    .select()
    .from(run)
    .where(
      and(
        eq(run.purpose, "mail_discovery"),
        sql`${run.input}->>'mailboxId' = ${mailboxId}`,
        sql`${run.input}->'controlled' IS NOT NULL`,
        inArray(run.status, ["running", "paused", "paused_auth"]),
        isNull(run.retiredAt),
        notDeleted(run),
      ),
    )
    .orderBy(asc(run.createdAt), asc(run.id))
    .limit(1);
  return row ?? null;
}

/** A control never interrupts an already started coordinator in this mailbox. */
export async function waitForActiveMailboxImports(
  db: Database,
  input: { mailboxId: string; memberId: string; controlRunId: RunId },
): Promise<void> {
  const [active] = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "mail_import"),
        eq(run.ledgerPartyId, parseEntityId("ledgerParty", input.memberId)),
        or(isNull(run.parentRunId), ne(run.parentRunId, input.controlRunId)),
        eq(run.status, "running"),
        or(
          isNotNull(run.coordinatorStartedAt),
          runJobLeaseLive(run.id, "purchase.dispatch"),
        ),
        notDeleted(run),
        exists(
          getDb(db)
            .select({ id: email.id })
            .from(email)
            .where(
              and(
                eq(email.runId, run.id),
                eq(email.mailboxId, input.mailboxId),
                notDeleted(email),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  if (active)
    throw new JobDeferredError(
      "Waiting for this mailbox's active Mail import to finish",
      new Date(Date.now() + 15_000),
      "provider_capacity",
    );
}

/**
 * Queued automatic imports retain their existing Job and source roster while
 * the mailbox is paused. A controlled child's parent authorizes only its
 * selected sources; a started coordinator is never interrupted here.
 */
export async function waitForMailImportPermission(
  db: Database,
  runId: RunId,
): Promise<void> {
  const [owner] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);
  if (
    !owner ||
    owner.purpose !== "mail_import" ||
    owner.trigger !== "discovery" ||
    owner.coordinatorStartedAt
  )
    return;
  const [parent] = owner.parentRunId
    ? await getDb(db)
        .select({ input: run.input })
        .from(run)
        .where(eq(run.id, owner.parentRunId))
        .limit(1)
    : [];
  if (mailboxDiscoveryInput.safeParse(parent?.input).data?.controlled) return;
  const sources = await getDb(db)
    .selectDistinct({ mailboxId: email.mailboxId })
    .from(email)
    .where(and(eq(email.runId, owner.id), notDeleted(email)));
  const settings = await readMailImportSettings(db);
  for (const source of sources) {
    const control = await findControlledMailImport(db, source.mailboxId);
    // The ordinary switch still governs new admission. A controlled request
    // additionally pauses already queued imports until the member resumes it.
    if (
      !control &&
      !settings.controlledPauses.some(
        (pause) => pause.mailboxId === source.mailboxId,
      )
    )
      continue;
    throw new JobDeferredError(
      "Automatic Mail import is paused for this mailbox",
      new Date(Date.now() + 60_000),
      "provider_capacity",
    );
  }
}
