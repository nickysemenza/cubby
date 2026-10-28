import { assessmentFamily } from "@cubby/schemas/assessment";
import type { ActorContext } from "@cubby/schemas/context";
import { emailFiltersSchema, type EmailFilters } from "@cubby/schemas/email";
import { emailRawOut as rawEmailOut } from "@cubby/schemas/entity-contracts/email";
import { parseEntityId, userId } from "@cubby/schemas/identifiers";
import {
  mailboxClassification,
  mailboxClassificationStage,
  relevanceLabel,
} from "@cubby/schemas/mailbox-research";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import {
  expense,
  product,
  feedback,
  assessment,
  emailClassificationObservation,
  ledgerParty,
  email as emailTable,
  emailFinancialAssociation,
  shipmentSourceCapture,
  vendorAccount,
} from "~/server/db/schema";
import { readEmailFinancialAssociations } from "~/server/domains/email/repo/email-financial-associations";
import { readEmailPurchaseAssociations } from "~/server/domains/email/repo/email-purchase-associations";
import {
  emailInScopeSql,
  cachedEmailLinkedSql,
  emailLinkRankSql,
  emailLinkStateSql,
  readCachedEmailPurchaseLinks,
  strongestLinkState,
  type EmailPurchaseScope,
} from "~/server/domains/email/repo/email-purchase-links";
import {
  EMAIL_OBSERVATION_PUBLICATION_PREFIX,
  emailFeedbackClassificationSql,
  emailFeedbackHasClassificationSql,
  emailLinkedSql,
  emailPurchaseAssociationsSql,
  emailReviewConflictSql,
} from "~/server/domains/email/repo/email-sql";
import { loadEmailImportOutcomes } from "~/server/domains/email/repo/import-outcome";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { listPrepare } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import { type ListReadOptions } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

type EmailRow = typeof emailTable.$inferSelect;

/** Member-owned navigation derives from evidence; thread context never binds a Purchase. */
export async function readEmailAssociations(
  db: Database | DrizzleTransaction,
  code: string,
  actor: ActorContext,
) {
  const client = unwrapDb(db);
  const id = await resolveOrThrow(db, "email", code);
  const owned = and(
    eq(ledgerParty.id, emailTable.ledgerPartyId),
    eq(ledgerParty.userId, actor.userId),
    notDeleted(ledgerParty),
  );
  const [selected] = await client
    .select({ email: emailTable })
    .from(emailTable)
    .innerJoin(ledgerParty, owned)
    .where(and(eq(emailTable.id, id), notDeleted(emailTable)))
    .limit(1);
  if (!selected) throw new Error("Email was not found for this member.");
  const purchases = await readEmailPurchaseAssociations(
    db,
    parseEntityId("email", selected.email.id),
  );
  const purchaseIds = purchases
    .filter((row) => !row.purchaseDeleted)
    .map((row) => row.id);
  const expenses = purchaseIds.length
    ? await client
        .select({
          id: expense.id,
          shortcode: expense.shortcode,
          name: expense.name,
          productId: expense.productId,
        })
        .from(expense)
        .where(
          and(inArray(expense.purchaseId, purchaseIds), notDeleted(expense)),
        )
    : [];
  const productIds = expenses.flatMap((row) =>
    row.productId ? [row.productId] : [],
  );
  const products = productIds.length
    ? await client
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
        })
        .from(product)
        .where(and(inArray(product.id, productIds), notDeleted(product)))
    : [];
  const emailFields = {
    shortcode: emailTable.shortcode,
    subject: emailTable.subject,
    sender: emailTable.sender,
    receivedAt: emailTable.receivedAt,
  };
  const otherOwnedEmails = and(
    notDeleted(emailTable),
    ne(emailTable.id, selected.email.id),
  );
  const samePurchaseEmails = purchaseIds.length
    ? await client
        .select(emailFields)
        .from(emailTable)
        .innerJoin(ledgerParty, owned)
        .where(
          and(
            otherOwnedEmails,
            sql`EXISTS (
      SELECT 1 FROM (${emailPurchaseAssociationsSql()}) association
      WHERE association."purchaseId" IN (${sql.join(
        purchaseIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    )`,
          ),
        )
        .orderBy(desc(emailTable.receivedAt), emailTable.id)
    : [];
  const threadEmails = selected.email.threadId
    ? await client
        .select(emailFields)
        .from(emailTable)
        .innerJoin(ledgerParty, owned)
        .where(
          and(
            otherOwnedEmails,
            eq(emailTable.ledgerPartyId, selected.email.ledgerPartyId),
            eq(emailTable.provider, selected.email.provider),
            eq(emailTable.mailboxId, selected.email.mailboxId),
            eq(emailTable.threadId, selected.email.threadId),
          ),
        )
        .orderBy(desc(emailTable.receivedAt), emailTable.id)
    : [];
  return {
    financialAssociations: await readEmailFinancialAssociations(
      db,
      parseEntityId("email", selected.email.id),
    ),
    purchases,
    expenses,
    products,
    samePurchaseEmails,
    threadEmails,
  };
}

/** Accepted order, lifecycle, financial or shipment evidence protects its original. */
export async function hasAcceptedEmailAssociation(
  db: Database | DrizzleTransaction,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    provider?: string;
  },
): Promise<boolean> {
  // Literal qualification preserves the outer correlation in a single-table projection.
  const [record] = await unwrapDb(db)
    .select({
      linked: sql<boolean>`(${emailLinkedSql()} OR EXISTS (
      SELECT 1 FROM ${emailFinancialAssociation} reviewed_financial_evidence
      WHERE reviewed_financial_evidence."emailId" = "Email"."id"
    ) OR EXISTS (
      SELECT 1 FROM ${shipmentSourceCapture} shipment_evidence
      WHERE shipment_evidence."emailId" = "Email"."id"
    ))`,
    })
    .from(emailTable)
    .where(
      and(
        sql`${emailTable.ledgerPartyId} = ${input.ledgerPartyId}::uuid`,
        eq(emailTable.provider, input.provider ?? "gmail"),
        eq(emailTable.mailboxId, input.mailboxId),
        eq(emailTable.messageId, input.messageId),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  return record?.linked ?? false;
}

// Link order is relative to the list's scope filter, so it reads the scope
// the request resolves.
const emailScope = listPrepare(async (db, filters) => {
  const parsed = emailScopeFilters.parse(filters);
  return {
    scope: await resolveEmailScope(db, parsed),
    fixedLinkState: oneOrManyValues(parsed.linkState)?.length === 1,
  };
});
const emailScopeFilters = emailFiltersSchema.pick({
  purchaseId: true,
  vendorId: true,
  vendorAccountId: true,
  linkState: true,
});

// One scope record across the three filters (`resolveEmailScope`), so each
// filter that names it applies the same condition.
const inScope = emailScope.predicate(({ scope }) =>
  scope ? emailInScopeSql(scope) : undefined,
);

/**
 * The record an Emails section is scoped to, resolved from the list's
 * `purchaseId`/`vendorId`/`vendorAccountId` filter. A declared exception to
 * any-of: `linkState` is relative to one scope record, so exactly one value
 * across the three is accepted (a scalar reads as a one-element list).
 */
export async function resolveEmailScope(
  db: Database | DrizzleTransaction,
  filters: Pick<EmailFilters, "purchaseId" | "vendorId" | "vendorAccountId">,
): Promise<EmailPurchaseScope | null> {
  const purchaseIds = oneOrManyValues(filters.purchaseId) ?? [];
  const vendorIds = oneOrManyValues(filters.vendorId) ?? [];
  const vendorAccountIds = oneOrManyValues(filters.vendorAccountId) ?? [];
  if (purchaseIds.length + vendorIds.length + vendorAccountIds.length > 1)
    throw new Error(
      "Scope an Email list by one value of purchaseId, vendorId or vendorAccountId.",
    );
  const [purchaseId] = purchaseIds;
  if (purchaseId)
    return {
      kind: "purchase",
      purchaseId: await resolveOrThrow(db, "purchase", purchaseId),
    };
  const [vendorId] = vendorIds;
  if (vendorId)
    return {
      kind: "vendor",
      vendorId: await resolveOrThrow(db, "vendor", vendorId),
    };
  const [vendorAccountId] = vendorAccountIds;
  if (!vendorAccountId) return null;
  const accountId = await resolveOrThrow(db, "vendorAccount", vendorAccountId);
  const [account] = await unwrapDb(db)
    .select({
      vendorId: vendorAccount.vendorId,
      ownerId: vendorAccount.ledgerPartyId,
    })
    .from(vendorAccount)
    .where(eq(vendorAccount.id, accountId))
    .limit(1);
  if (!account) throw new Error(`${vendorAccountId} does not exist.`);
  return { kind: "vendorAccount", ...account };
}

const emailRead: ListReadOptions<EmailRow> = {
  media: true,
  // includes-deleted: immutable mail metadata retains its original owner and Run.
  references: {
    ledgerPartyId: { kind: "lookup", missing: "error", includeDeleted: true },
    runId: { kind: "lookup", missing: "null", includeDeleted: true },
  },
  bindings: (bind) => {
    const facts = bind.batch(async ({ db, rows, context, idPage }) => {
      // The actor reads `ownedByViewer`; a read without one owns nothing. An
      // unscoped read loads no `emailScope` and links across every Purchase.
      const viewer = context.actor ?? null;
      const scope = context.has(emailScope)
        ? context.get(emailScope).scope
        : null;
      // includes-deleted: immutable mail metadata keeps naming its owner and Run.
      const [associations, reviews, purchaseLinks, owners] = await Promise.all([
        rows.length === 0
          ? []
          : unwrapDb(db)
              .select({
                id: emailTable.id,
                reviewConflict: emailReviewConflictSql(),
              })
              .from(emailTable)
              .where(
                and(
                  inArray(
                    emailTable.id,
                    rows.map((row) => row.id),
                  ),
                  notDeleted(emailTable),
                ),
              ),
        rows.length === 0
          ? []
          : unwrapDb(db)
              .select({
                emailId: emailTable.id,
                classification: emailFeedbackClassificationSql(
                  sql`${feedback}`,
                  sql`${assessment}`,
                ),
                reason: feedback.reason,
              })
              .from(emailTable)
              .innerJoin(
                ledgerParty,
                eq(ledgerParty.id, emailTable.ledgerPartyId),
              )
              .innerJoin(
                emailClassificationObservation,
                and(
                  eq(emailClassificationObservation.emailId, emailTable.id),
                  eq(
                    emailClassificationObservation.checksum,
                    emailTable.checksum,
                  ),
                ),
              )
              .innerJoin(
                assessment,
                and(
                  eq(assessment.family, assessmentFamily.enum.email_relevance),
                  eq(
                    assessment.publicationKey,
                    sql`${EMAIL_OBSERVATION_PUBLICATION_PREFIX} || ${emailClassificationObservation.id}::text`,
                  ),
                  // The key finds the row; its subject remains the lineage authority.
                  eq(
                    sql`${assessment.subject}->>'observationId'`,
                    sql`${emailClassificationObservation.id}::text`,
                  ),
                ),
              )
              .innerJoin(
                feedback,
                and(
                  eq(feedback.assessmentId, assessment.id),
                  eq(feedback.authority, "member"),
                  eq(feedback.actorUserId, ledgerParty.userId),
                  emailFeedbackHasClassificationSql(
                    sql`${feedback}`,
                    sql`${assessment}`,
                  ),
                ),
              )
              .where(
                and(
                  inArray(
                    emailTable.id,
                    rows.map((row) => row.id),
                  ),
                  notDeleted(emailTable),
                  notDeleted(ledgerParty),
                ),
              )
              .orderBy(desc(feedback.createdAt), desc(feedback.id)),
        readCachedEmailPurchaseLinks(db, rows, scope, idPage.stored),
        viewer === null || rows.length === 0
          ? []
          : unwrapDb(db)
              .select({ id: ledgerParty.id })
              .from(ledgerParty)
              .where(
                and(
                  inArray(
                    ledgerParty.id,
                    rows.map((row) =>
                      parseEntityId("ledgerParty", row.ledgerPartyId),
                    ),
                  ),
                  eq(ledgerParty.userId, userId.parse(viewer.userId)),
                ),
              ),
      ]);
      const latestReviews = new Map<
        typeof emailTable.$inferSelect.id,
        (typeof reviews)[number]
      >();
      for (const review of reviews)
        if (!latestReviews.has(review.emailId))
          latestReviews.set(review.emailId, review);
      const outcomes = await loadEmailImportOutcomes(
        db,
        rows.map((row) => ({
          id: row.id,
          accepted: purchaseLinks.get(row.id)?.accepted ?? null,
        })),
      );
      return {
        reviews: latestReviews,
        linked: new Map(
          [...purchaseLinks].map(([id, value]) => [id, value.linked]),
        ),
        reviewConflict: new Map(
          associations.map((row) => [row.id, row.reviewConflict]),
        ),
        importOutcome: outcomes,
        purchaseLinks,
        viewerParties: new Set<string>(owners.map((row) => row.id)),
      };
    });
    return [
      bind(
        rawEmailOut.pick({ displayName: true, relevanceLabel: true }),
        (row) => ({
          displayName:
            row.subject?.trim() || row.sender?.trim() || row.shortcode,
          relevanceLabel: relevanceLabel(
            mailboxClassification.nullable().parse(row.classification),
            mailboxClassificationStage
              .nullable()
              .parse(row.classificationStage),
          ),
        }),
      ),
      facts.fields(
        rawEmailOut.pick({
          storedProjectionVersions: true,
          linked: true,
          reviewConflict: true,
          purchaseLinks: true,
          ownedByViewer: true,
          linkState: true,
          importOutcome: true,
          reviewedClassification: true,
          reviewedClassificationReason: true,
        }),
        (row, loaded) => ({
          linked: loaded.linked.get(row.id) ?? null,
          reviewConflict: loaded.reviewConflict.get(row.id) ?? false,
          storedProjectionVersions: {
            linked: loaded.purchaseLinks.get(row.id)?.computedAt ?? null,
            importOutcome: loaded.purchaseLinks.get(row.id)?.computedAt ?? null,
            linkState: loaded.purchaseLinks.get(row.id)?.computedAt ?? null,
            purchaseLinks: loaded.purchaseLinks.get(row.id)?.computedAt ?? null,
          },
          purchaseLinks: loaded.purchaseLinks.get(row.id)?.links ?? null,
          ownedByViewer: loaded.viewerParties.has(row.ledgerPartyId),
          linkState: loaded.purchaseLinks.has(row.id)
            ? strongestLinkState(loaded.purchaseLinks.get(row.id)?.links ?? [])
            : null,
          importOutcome: loaded.importOutcome.get(row.id) ?? null,
          reviewedClassification:
            loaded.reviews.get(row.id)?.classification ?? null,
          reviewedClassificationReason:
            loaded.reviews.get(row.id)?.reason ?? null,
        }),
      ),
    ];
  },
};

export const emailScaffold = listScaffold("email", emailTable, {
  derived: {
    // Ties read newest first in either direction.
    linkState: emailScope.value(({ scope, fixedLinkState }) => [
      // A single included state fixes the rank; retain date and stable ties.
      fixedLinkState ? sql`0::integer` : emailLinkRankSql(scope),
      { sql: sql`${emailTable.receivedAt}`, direction: "desc" },
    ]),
    scopeLinkState: emailScope.value(({ scope }) => emailLinkStateSql(scope)),
    linked: cachedEmailLinkedSql(),
    reviewConflict: emailReviewConflictSql(),
    purchaseId: inScope,
    vendorId: inScope,
    vendorAccountId: inScope,
  },
  read: {
    ...emailRead,
    title: sql`${emailTable.subject}`,
  },
});

export const emailRepository = defineRepository("email", {
  scaffold: emailScaffold,
});
