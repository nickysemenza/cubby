import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import {
  mailCoverage,
  mailCoverageRow,
  type MailCoverage,
  type MailCoverageRow,
} from "@cubby/schemas/mail-coverage";
import {
  mailboxCoverage,
  mailboxClassification,
  emailStatus,
  mergeMailboxQueries,
  currentScopedPosition,
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
} from "@cubby/schemas/mailbox-research";
import { runPurpose } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { and, desc, eq, isNotNull, isNull, inArray, sql } from "drizzle-orm";

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

import { listMemberMailboxes, listGmailSyncTargets } from "./targets";
import { vendorSearchTerms } from "./vendor-identity";
import { vendorMailQueries } from "./vendor-mail-scope";

const activeRunStatuses = new Set<string>(ACTIVE_RUN_STATUSES);
const hasPurchase = sql`EXISTS (SELECT 1 FROM (${emailPurchaseEvidenceSql()}) evidence WHERE evidence.kind IN (${emailLinkEvidenceKind.enum.accepted}, ${emailLinkEvidenceKind.enum.linked}))`;
const hasImport = sql`EXISTS (SELECT 1 FROM (${emailPurchaseEvidenceSql()}) evidence WHERE evidence.kind = ${emailLinkEvidenceKind.enum.accepted})`;
// A retained, relevant original without seller proof or accepted Purchase evidence.
const sellerUnresolved = sql`${email.classification} = ${mailboxClassification.enum.related} AND ${orderMail.id} IS NOT NULL AND ${email.contentClearedAt} IS NULL AND ${orderMail.vendorId} IS NULL AND NOT ${hasPurchase}`;

/** Queue activity and import admission are distinct from historical search coverage. */
function summarizeQueue({
  controlledRun,
  running,
  position,
  active,
  pause,
  enabled,
  searchTerms,
}: {
  controlledRun: MailCoverageRow["controlledRun"];
  running: boolean;
  position: number | null;
  active: { id: string; status: string } | undefined;
  pause: boolean;
  enabled: boolean;
  searchTerms: readonly string[];
}): MailCoverageRow["queue"] {
  const controlledActive =
    controlledRun &&
    (activeRunStatuses.has(controlledRun.status) ||
      controlledRun.imports.running > 0 ||
      controlledRun.imports.paused > 0);
  const controlledRunning =
    controlledActive &&
    !controlledRun.queued &&
    (controlledRun.status === "running" || controlledRun.imports.running > 0);
  const controlledPaused =
    controlledActive && !controlledRunning && !controlledRun.queued;
  return mailCoverageRow.shape.queue.parse({
    state:
      running || controlledRunning
        ? "running"
        : controlledActive && controlledRun.queued
          ? "queued"
          : controlledPaused ||
              (position !== null &&
                (pause || (active && active.status !== "running")))
            ? "paused"
            : position !== null
              ? "queued"
              : "idle",
    position: controlledActive && controlledRun.queued ? 1 : position,
    runId: controlledActive
      ? controlledRun.id
      : running || (position !== null && active?.status !== "running")
        ? (active?.id ?? null)
        : null,
    reason:
      searchTerms.length === 0
        ? "Add a website or verified sender to the Vendor."
        : controlledPaused
          ? "Selected work is paused; open its Run for recovery."
          : pause && !controlledActive
            ? "Other imports are paused until you resume this mailbox; automatic searches may still classify mail."
            : !enabled && !controlledActive
              ? "Automatic import is off; discovery can still search and classify mail."
              : active && active.status !== "running"
                ? `Discovery is ${active.status.replaceAll("_", " ")}; open its Run for recovery.`
                : controlledActive && controlledRun.queued
                  ? "Waiting for active work to finish."
                  : position !== null
                    ? "Position among pending targeted queries in this mailbox; new-mail checks may run between searches."
                    : null,
  });
}

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
    discoveryRuns,
    targets,
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
        related:
          sql<number>`count(*) FILTER (WHERE ${email.classification} = ${mailboxClassification.enum.related})`.mapWith(
            Number,
          ),
        pending:
          sql<number>`count(*) FILTER (WHERE ${email.status} = ${emailStatus.enum.pending})`.mapWith(
            Number,
          ),
        blocked:
          sql<number>`count(*) FILTER (WHERE ${email.status} = ${emailStatus.enum.blocked})`.mapWith(
            Number,
          ),
        linkedEmails:
          sql<number>`count(*) FILTER (WHERE ${hasPurchase})`.mapWith(Number),
        imported: sql<number>`count(*) FILTER (WHERE ${hasImport})`.mapWith(
          Number,
        ),
        sellerUnresolved:
          sql<number>`count(*) FILTER (WHERE ${sellerUnresolved})`.mapWith(
            Number,
          ),
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
        purchaseIds: sql<string[]>`array_agg(DISTINCT ${purchase.shortcode})`,
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
        shortcode: run.shortcode,
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
        lastPolledAt: mailboxCursor.lastPolledAt,
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
    getDb(db)
      .select({
        id: run.shortcode,
        mailboxId: sql<string>`${run.input}->>'mailboxId'`,
        status: run.status,
        failureCode: run.failureCode,
        input: run.input,
        progress: run.progress,
      })
      .from(run)
      .where(
        and(
          eq(run.purpose, runPurpose.enum.mail_discovery),
          isNull(run.retiredAt),
          inArray(run.status, [
            "running",
            "paused",
            "paused_auth",
            "paused_offline",
          ]),
          notDeleted(run),
        ),
      )
      .orderBy(desc(run.startedAt), desc(run.id)),
    listGmailSyncTargets(db),
  ]);
  const unresolvedEmails = (
    await Promise.all(
      members.map((member) =>
        getDb(db)
          .select({
            id: email.shortcode,
            mailboxId: email.mailboxId,
            sender: email.sender,
            subject: email.subject,
            receivedAt: email.receivedAt,
          })
          .from(email)
          .leftJoin(
            orderMail,
            and(
              eq(orderMail.id, email.orderMailId),
              eq(orderMail.ledgerPartyId, email.ledgerPartyId),
            ),
          )
          .where(
            and(
              notDeleted(email),
              sellerUnresolved,
              eq(email.mailboxId, member.mailboxId),
              eq(email.ledgerPartyId, member.ledgerPartyId),
            ),
          )
          .orderBy(desc(email.receivedAt), desc(email.id))
          .limit(50),
      ),
    )
  ).flat();
  const terms = new Map(vendors.map((row) => [row.id, vendorSearchTerms(row)]));
  const vendorQueries = new Map(
    vendors.map((row) => [
      row.id,
      vendorMailQueries(row.id, terms.get(row.id) ?? []),
    ]),
  );
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
  const importsByParent = new Map<
    string,
    NonNullable<MailCoverageRow["controlledRun"]>["imports"]
  >();
  for (const child of importRuns) {
    if (!child.parentId) continue;
    const imports = importsByParent.get(child.parentId) ?? {
      running: 0,
      paused: 0,
      needsReview: 0,
      failed: 0,
      completed: 0,
    };
    switch (child.status) {
      case "running":
        imports.running += child.total;
        break;
      case "paused":
      case "paused_auth":
      case "paused_offline":
        imports.paused += child.total;
        break;
      case "needs_review":
        imports.needsReview += child.total;
        break;
      case "failed":
      case "dispatch_failed":
        imports.failed += child.total;
        break;
      case "completed":
        imports.completed += child.total;
        break;
    }
    importsByParent.set(child.parentId, imports);
  }
  for (const control of controls) {
    if (!control.vendorId || !control.ledgerPartyId) continue;
    const id = key(control.vendorId, control.ledgerPartyId, control.mailboxId);
    if (controlRuns.has(id)) continue;
    const scope = mailboxDiscoveryInput.safeParse(control.input);
    controlRuns.set(
      id,
      mailCoverageRow.shape.controlledRun.parse({
        id: control.id,
        status: control.status,
        queued: control.failureCode === "controlled_mail_queued",
        phase: control.phase,
        from: scope.success ? (scope.data.controlled?.from ?? null) : null,
        to: scope.success ? (scope.data.controlled?.to ?? null) : null,
        imports: importsByParent.get(control.internalId) ?? {
          running: 0,
          paused: 0,
          needsReview: 0,
          failed: 0,
          completed: 0,
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
    const target = targets.find(
      (entry) =>
        entry.mailboxId === member.mailboxId &&
        entry.ledgerPartyId === member.ledgerPartyId,
    );
    const active = discoveryRuns.find(
      (entry) =>
        entry.mailboxId === member.mailboxId &&
        entry.failureCode !== "controlled_mail_queued",
    );

    const ordered = coverage
      ? mergeMailboxQueries(coverage, target?.scopedQueries ?? []).scoped
      : (target?.scopedQueries ?? []).map((query) => ({
          ...query,
          completed: false,
          pageToken: null,
        }));
    const queryKey = (query: { key: string; query: string }) =>
      JSON.stringify([query.key, query.query]);
    const targetQueries = new Set((target?.scopedQueries ?? []).map(queryKey));
    // Positions count all pending targeted queries, including unmatched-charge queries.
    const pendingPositions = new Map<string, number>();
    let pendingCount = 0;
    for (const entry of ordered) {
      const id = queryKey(entry);
      if (entry.completed || !targetQueries.has(id)) continue;
      pendingCount += 1;
      if (!pendingPositions.has(id)) pendingPositions.set(id, pendingCount);
    }
    const progress = mailboxDiscoveryProgress.safeParse(active?.progress);
    // A pending cursor is not proof that the worker is processing this query now.
    const activeQueryKey = progress.success
      ? progress.data.page?.scopedKey
      : undefined;
    const pause = settings.controlledPauses.some(
      (entry) => entry.mailboxId === member.mailboxId,
    );
    const enabled = settings.enabledMailboxes.includes(member.mailboxId);
    return vendors.map((row) => {
      const searchTerms = terms.get(row.id) ?? [];
      const queries = vendorQueries.get(row.id) ?? [];
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
      const controlledRun =
        controlRuns.get(key(row.id, member.ledgerPartyId, member.mailboxId)) ??
        null;
      const queued = queries.flatMap((query) => {
        const position = pendingPositions.get(queryKey(query));
        return position === undefined ? [] : [position];
      });
      const position = queued.length ? Math.min(...queued) : null;
      const running =
        active?.status === "running" &&
        !!activeQueryKey &&
        queries.some((query) => query.key === activeQueryKey);
      const queue = summarizeQueue({
        controlledRun,
        running,
        position,
        active,
        pause,
        enabled,
        searchTerms,
      });
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
            runId: position?.runId ?? null,
            queuePosition: pendingPositions.get(queryKey(query)) ?? null,
          };
        }),
        queue,
        lastSearchedAt: dates.at(-1) ?? null,
        controlledRun:
          controlRuns.get(
            key(row.id, member.ledgerPartyId, member.mailboxId),
          ) ?? null,
        ...counts,
        linkedEmails: associated?.emails ?? 0,
        linkedRetainedEmails: associated?.retained ?? 0,
        linkedPurchases: associated?.purchases.size ?? 0,
        linkedPurchaseIds: [...(associated?.purchases ?? [])].sort(),
      };
    });
  });
  const discovery = members.map((member) => {
    const cursor = cursorRows.find(
      (row) =>
        row.memberId === member.ledgerPartyId &&
        row.mailboxId === member.mailboxId,
    );
    const coverage = cursor?.coverage
      ? mailboxCoverage.parse(cursor.coverage)
      : null;
    const target = targets.find(
      (row) =>
        row.ledgerPartyId === member.ledgerPartyId &&
        row.mailboxId === member.mailboxId,
    );
    const queries = (target?.scopedQueries ?? []).map((query) =>
      currentScopedPosition(coverage, query),
    );
    const active = discoveryRuns.find(
      (row) =>
        row.mailboxId === member.mailboxId &&
        row.failureCode !== "controlled_mail_queued",
    );
    const counts = observed.filter(
      (row) =>
        row.memberId === member.ledgerPartyId &&
        row.mailboxId === member.mailboxId,
    );
    const sum = (
      field:
        | "scanned"
        | "classified"
        | "retained"
        | "pending"
        | "blocked"
        | "imported"
        | "sellerUnresolved",
    ) => counts.reduce((total, row) => total + row[field], 0);
    return {
      mailboxId: member.mailboxId,
      lastPolledAt: cursor?.lastPolledAt?.toISOString() ?? null,
      newMailCatchupPending: coverage
        ? coverage.history.pageToken !== null
        : null,
      runId: active?.id ?? null,
      runStatus: active?.status ?? null,
      searchesCompleted: queries.filter((query) => query?.completed).length,
      searchesTotal: queries.length,
      scanned: sum("scanned"),
      classified: sum("classified"),
      retained: sum("retained"),
      pending: sum("pending"),
      blocked: sum("blocked"),
      imported: sum("imported"),
      sellerUnresolved: sum("sellerUnresolved"),
    };
  });
  const sharedSenders = members.flatMap((member) => {
    const coverage =
      cursors.get(`${member.ledgerPartyId}/${member.mailboxId}`) ?? null;
    const target = targets.find(
      (row) =>
        row.ledgerPartyId === member.ledgerPartyId &&
        row.mailboxId === member.mailboxId,
    );
    return (target?.scopedQueries ?? [])
      .filter((query) => query.key.startsWith("sender:"))
      .map((query) => {
        const sender = query.key.slice("sender:".length);
        const position = currentScopedPosition(coverage, query);
        const counts = observed.filter(
          (row) =>
            row.memberId === member.ledgerPartyId &&
            row.mailboxId === member.mailboxId &&
            senderAddress(row.sender) === sender,
        );
        const sum = (
          field:
            | "scanned"
            | "classified"
            | "retained"
            | "related"
            | "imported"
            | "linkedEmails"
            | "sellerUnresolved",
        ) => counts.reduce((total, row) => total + row[field], 0);
        const purchases = new Set(
          linked
            .filter(
              (row) =>
                row.memberId === member.ledgerPartyId &&
                row.mailboxId === member.mailboxId &&
                senderAddress(row.sender) === sender,
            )
            .flatMap((row) => row.purchaseIds),
        );
        return {
          mailboxId: member.mailboxId,
          sender,
          query: query.query,
          state: position?.completed
            ? "complete"
            : position?.pageToken
              ? "in_progress"
              : "not_started",
          completedAt: position?.completedAt ?? null,
          runId: position?.runId ?? null,
          scanned: sum("scanned"),
          classified: sum("classified"),
          retained: sum("retained"),
          related: sum("related"),
          imported: sum("imported"),
          linkedEmails: sum("linkedEmails"),
          linkedPurchases: purchases.size,
          sellerUnresolved: sum("sellerUnresolved"),
        };
      });
  });
  return mailCoverage.parse({
    mailboxes,
    rows,
    discovery,
    sharedSenders,
    unresolvedEmails: unresolvedEmails
      .filter((row) =>
        members.some((member) => member.mailboxId === row.mailboxId),
      )
      .map((row) => ({
        ...row,
        receivedAt: row.receivedAt?.toISOString() ?? null,
      })),
  });
}
