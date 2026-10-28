import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import {
  mailCoverage,
  mailCoverageRow,
  type MailCoverage,
  type MailCoverageRow,
} from "@cubby/schemas/mail-coverage";
import {
  mailboxCoverage,
  currentScopedPosition,
  mailboxDiscoveryInput,
} from "@cubby/schemas/mailbox-research";
import { runPurpose } from "@cubby/schemas/run-fields";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { distinctSenderDomain, senderAddress } from "~/lib/vendor/domains";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  email,
  mailboxCursor,
  orderMail,
  purchase,
  run,
  vendor,
  vendorAccount,
} from "~/server/db/retained-tables";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";
import { completedControlledSearches } from "~/server/domains/purchase-import/repo/controlled-mail-import";
import { readMailImportSettings } from "~/server/domains/purchase-import/repo/mail-import-settings";

import { listMemberMailboxes } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";
import { vendorMailQueries } from "./vendor-mail-scope";

/** Complete household report; grouped metadata avoids a query per Vendor/mailbox row. */
export async function readMailCoverage(
  db: Database,
  viewerUserId: string,
): Promise<MailCoverage> {
  const [
    members,
    vendors,
    accounts,
    settings,
    observed,
    linked,
    controls,
    cursorRows,
    importRuns,
  ] = await Promise.all([
    listMemberMailboxes(db),
    getDb(db)
      .select({
        id: vendor.id,
        shortcode: vendor.shortcode,
        name: vendor.name,
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(and(notDeleted(vendor), isNull(vendor.systemKey)))
      .orderBy(vendor.name, vendor.id),
    getDb(db)
      .select({
        vendorId: vendorAccount.vendorId,
        memberId: vendorAccount.ledgerPartyId,
        shortcode: vendorAccount.shortcode,
        name: vendorAccountLabelSql,
      })
      .from(vendorAccount)
      .where(notDeleted(vendorAccount)),
    readMailImportSettings(db),
    getDb(db)
      .select({
        mailboxId: email.mailboxId,
        memberId: email.ledgerPartyId,
        sender: email.sender,
        vendorId: orderMail.vendorId,
        scanned: sql<number>`count(*)`.mapWith(Number),
        classified:
          sql<number>`count(*) FILTER (WHERE ${email.classification} IS NOT NULL)`.mapWith(
            Number,
          ),
        retained:
          sql<number>`count(*) FILTER (WHERE ${orderMail.id} IS NOT NULL AND ${email.contentClearedAt} IS NULL)`.mapWith(
            Number,
          ),
      })
      .from(email)
      .leftJoin(
        orderMail,
        and(
          eq(orderMail.id, email.orderMailId),
          eq(orderMail.ledgerPartyId, email.ledgerPartyId),
        ),
      )
      .where(notDeleted(email))
      .groupBy(
        email.mailboxId,
        email.ledgerPartyId,
        email.sender,
        orderMail.vendorId,
      ),
    getDb(db)
      .select({
        mailboxId: email.mailboxId,
        memberId: email.ledgerPartyId,
        vendorId: purchase.vendorId,
        sender: email.sender,
        attributedVendorId: orderMail.vendorId,
        classified:
          sql<number>`count(DISTINCT ${email.id}) FILTER (WHERE ${email.classification} IS NOT NULL)`.mapWith(
            Number,
          ),
        retained:
          sql<number>`count(DISTINCT ${email.id}) FILTER (WHERE ${orderMail.id} IS NOT NULL AND ${email.contentClearedAt} IS NULL)`.mapWith(
            Number,
          ),
        emails: sql<number>`count(DISTINCT ${email.id})`.mapWith(Number),
        purchaseIds: sql<string[]>`array_agg(DISTINCT ${purchase.id})`,
      })
      .from(email)
      .leftJoin(
        orderMail,
        and(
          eq(orderMail.id, email.orderMailId),
          eq(orderMail.ledgerPartyId, email.ledgerPartyId),
        ),
      )
      .innerJoin(
        sql`LATERAL (${emailPurchaseEvidenceSql()}) evidence`,
        sql`evidence.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked})`,
      )
      .innerJoin(
        purchase,
        and(sql`${purchase.id} = evidence."purchaseId"`, notDeleted(purchase)),
      )
      .where(notDeleted(email))
      .groupBy(
        email.mailboxId,
        email.ledgerPartyId,
        purchase.vendorId,
        email.sender,
        orderMail.vendorId,
      ),
    getDb(db)
      .select({
        id: run.shortcode,
        internalId: run.id,
        vendorId: run.vendorId,
        ledgerPartyId: run.ledgerPartyId,
        mailboxId: sql<string>`${run.input}->>'mailboxId'`,
        status: run.status,
        failureCode: run.failureCode,
        phase: sql<string | null>`${run.progress}->>'phase'`,
        input: run.input,
        endedAt: run.endedAt,
      })
      .from(run)
      .where(
        and(
          eq(run.purpose, runPurpose.enum.mail_discovery),
          isNotNull(run.vendorId),
          sql`${run.input}->'controlled' IS NOT NULL`,
          notDeleted(run),
        ),
      )
      .orderBy(desc(run.startedAt), desc(run.id)),
    getDb(db)
      .select({
        memberId: mailboxCursor.ledgerPartyId,
        mailboxId: mailboxCursor.mailboxId,
        coverage: mailboxCursor.coverage,
      })
      .from(mailboxCursor)
      .where(eq(mailboxCursor.provider, "gmail")),
    getDb(db)
      .select({
        parentId: run.parentRunId,
        status: run.status,
        total: sql<number>`count(*)`.mapWith(Number),
      })
      .from(run)
      .where(
        and(
          eq(run.purpose, runPurpose.enum.mail_import),
          isNotNull(run.parentRunId),
          notDeleted(run),
        ),
      )
      .groupBy(run.parentRunId, run.status),
  ]);
  const terms = new Map(vendors.map((row) => [row.id, vendorSearchTerms(row)]));
  const identities = new Map<string, Set<string>>();
  for (const row of vendors) {
    for (const term of terms.get(row.id) ?? []) {
      const ids = identities.get(term) ?? new Set<string>();
      ids.add(row.id);
      identities.set(term, ids);
    }
  }
  const observedCounts = new Map<
    string,
    { scanned: number; classified: number; retained: number }
  >();
  const key = (vendorId: string, memberId: string, mailboxId: string) =>
    `${vendorId}/${memberId}/${mailboxId}`;
  const matchingVendors = (
    sender: string | null,
    attributedVendorId: string | null,
  ) => {
    const address = senderAddress(sender);
    const domain = address ? distinctSenderDomain(address) : null;
    // Discovery hints and explicit sender proof are not the only evidence: accepted links also establish scope below.
    return new Set([
      ...(address ? (identities.get(address) ?? []) : []),
      ...(domain ? (identities.get(domain) ?? []) : []),
      ...(attributedVendorId ? [attributedVendorId] : []),
    ]);
  };
  for (const row of observed) {
    const matching = matchingVendors(row.sender, row.vendorId);
    for (const vendorId of matching) {
      const id = key(vendorId, row.memberId, row.mailboxId);
      const current = observedCounts.get(id) ?? {
        scanned: 0,
        classified: 0,
        retained: 0,
      };
      current.scanned += row.scanned;
      current.classified += row.classified;
      current.retained += row.retained;
      observedCounts.set(id, current);
    }
  }
  const links = new Map<
    string,
    { emails: number; retained: number; purchases: Set<string> }
  >();
  for (const row of linked) {
    const id = key(row.vendorId, row.memberId, row.mailboxId);
    const associated = links.get(id) ?? {
      emails: 0,
      retained: 0,
      purchases: new Set<string>(),
    };
    associated.emails += row.emails;
    associated.retained += row.retained;
    for (const purchaseId of row.purchaseIds)
      associated.purchases.add(purchaseId);
    links.set(id, associated);
    // Each Email has one sender/proof group. Add authoritative linked evidence only if discovery matching did not already count it.
    if (
      !matchingVendors(row.sender, row.attributedVendorId).has(row.vendorId)
    ) {
      const counts = observedCounts.get(id) ?? {
        scanned: 0,
        classified: 0,
        retained: 0,
      };
      counts.scanned += row.emails;
      counts.classified += row.classified;
      counts.retained += row.retained;
      observedCounts.set(id, counts);
    }
  }
  const controlRuns = new Map<string, MailCoverageRow["controlledRun"]>();
  const completedSearches = completedControlledSearches(controls);
  for (const control of controls) {
    if (!control.vendorId || !control.ledgerPartyId) continue;
    const id = key(control.vendorId, control.ledgerPartyId, control.mailboxId);
    const scope = mailboxDiscoveryInput.safeParse(control.input);
    if (!controlRuns.has(id))
      controlRuns.set(
        id,
        mailCoverageRow.shape.controlledRun.parse({
          id: control.id,
          status: control.status,
          queued: control.failureCode === "controlled_mail_queued",
          phase: control.phase,
          from: scope.success ? (scope.data.controlled?.from ?? null) : null,
          to: scope.success ? (scope.data.controlled?.to ?? null) : null,
          imports: {
            running: importRuns
              .filter(
                (child) =>
                  child.parentId === control.internalId &&
                  [
                    "running",
                    "paused",
                    "paused_auth",
                    "paused_offline",
                  ].includes(child.status),
              )
              .reduce((total, child) => total + child.total, 0),
            needsReview: importRuns
              .filter(
                (child) =>
                  child.parentId === control.internalId &&
                  child.status === "needs_review",
              )
              .reduce((total, child) => total + child.total, 0),
            failed: importRuns
              .filter(
                (child) =>
                  child.parentId === control.internalId &&
                  ["failed", "dispatch_failed"].includes(child.status),
              )
              .reduce((total, child) => total + child.total, 0),
            completed: importRuns
              .filter(
                (child) =>
                  child.parentId === control.internalId &&
                  child.status === "completed",
              )
              .reduce((total, child) => total + child.total, 0),
          },
        }),
      );
  }
  const accountCodes = new Map(
    accounts.map((row) => [`${row.vendorId}/${row.memberId}`, row]),
  );
  const cursors = new Map(
    cursorRows.map((row) => [
      `${row.memberId}/${row.mailboxId}`,
      row.coverage ? mailboxCoverage.parse(row.coverage) : null,
    ]),
  );
  const mailboxes = members.map((member, index) => ({
    mailboxId: member.mailboxId,
    memberId: member.memberShortcode,
    memberName: member.name,
    // The provider's numeric account ID is not a readable mailbox name.
    label:
      members.filter((other) => other.ledgerPartyId === member.ledgerPartyId)
        .length > 1
        ? `${member.name} · Gmail ${members.slice(0, index + 1).filter((other) => other.ledgerPartyId === member.ledgerPartyId).length}`
        : `${member.name} · Gmail`,
    enabled: settings.enabledMailboxes.includes(member.mailboxId),
    resumeEnabled:
      settings.controlledPauses.find(
        (pause) => pause.mailboxId === member.mailboxId,
      )?.enabledBefore ?? null,
    canControl: member.userId === viewerUserId,
  }));
  const rows = members.flatMap((member) => {
    const coverage =
      cursors.get(`${member.ledgerPartyId}/${member.mailboxId}`) ?? null;
    return vendors.map((row) => {
      const searchTerms = terms.get(row.id) ?? [];
      const queries = vendorMailQueries(row.id, searchTerms);
      const searched = queries.map((query) =>
        currentScopedPosition(
          coverage,
          query,
          completedSearches.get(
            key(row.id, member.ledgerPartyId, member.mailboxId),
          ),
        ),
      );
      const complete = searched.filter((entry) => entry?.completed).length;
      const counts = observedCounts.get(
        key(row.id, member.ledgerPartyId, member.mailboxId),
      ) ?? { scanned: 0, classified: 0, retained: 0 };
      const associated = links.get(
        key(row.id, member.ledgerPartyId, member.mailboxId),
      );
      const allCountsKnown = searched.every(
        (entry) => entry?.messageCount !== undefined,
      );
      const hasMatches = searched.some(
        (entry) => (entry?.messageCount ?? 0) > 0,
      );
      const state: MailCoverageRow["state"] =
        queries.length === 0
          ? "no_search_identity"
          : complete === queries.length
            ? allCountsKnown
              ? hasMatches
                ? "matches_found"
                : "no_matches"
              : "complete"
            : searched.some(
                  (entry) =>
                    entry && (entry.completed || entry.pageToken !== null),
                )
              ? "in_progress"
              : "not_started";
      const dates = searched
        .flatMap((entry) => (entry?.completedAt ? [entry.completedAt] : []))
        .sort();
      return {
        key: `${row.shortcode}/${member.mailboxId}`,
        vendorId: row.shortcode,
        vendorName: row.name,
        vendorAccountId:
          accountCodes.get(`${row.id}/${member.ledgerPartyId}`)?.shortcode ??
          null,
        vendorAccountName:
          accountCodes.get(`${row.id}/${member.ledgerPartyId}`)?.name ?? null,
        mailboxId: member.mailboxId,
        memberId: member.memberShortcode,
        searchTerms,
        state,
        searchesCompleted: complete,
        searchesTotal: queries.length,
        searches: queries.map((query, index) => {
          const position = searched[index];
          return {
            query: query.query,
            state: position?.completed
              ? "complete"
              : position && position.pageToken !== null
                ? "in_progress"
                : "not_started",
            completedAt: position?.completedAt ?? null,
          };
        }),
        lastSearchedAt:
          complete === queries.length && dates.length === queries.length
            ? (dates.at(-1) ?? null)
            : null,
        controlledRun:
          controlRuns.get(
            key(row.id, member.ledgerPartyId, member.mailboxId),
          ) ?? null,
        ...counts,
        linkedEmails: associated?.emails ?? 0,
        linkedRetainedEmails: associated?.retained ?? 0,
        linkedPurchases: associated?.purchases.size ?? 0,
      };
    });
  });
  return mailCoverage.parse({ mailboxes, rows });
}
