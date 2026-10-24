import type { ActorContext } from "@cubby/schemas/context";
import {
  emailFilters,
  emailOut,
  type EmailFilters,
  type EmailOut,
} from "@cubby/schemas/email";
import { emailImportOutcome } from "@cubby/schemas/email-fields";
import { parseEntityId, userId } from "@cubby/schemas/identifiers";
import {
  mailboxClassification,
  mailboxClassificationStage,
  relevanceLabel,
} from "@cubby/schemas/mailbox-research";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import { runStatus } from "@cubby/schemas/run-fields";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import {
  expense,
  product,
  feedback,
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
  emailLinkRankSql,
  emailLinkStateSql,
  readEmailPurchaseLinks,
  strongestLinkState,
  type EmailPurchaseScope,
} from "~/server/domains/email/repo/email-purchase-links";
import {
  emailAcceptedEvidenceSql,
  emailFeedbackObservationIdSql,
  emailFeedbackClassificationSql,
  emailFeedbackHasClassificationSql,
  emailLinkedSql,
  emailPurchaseAssociationsSql,
  emailReviewConflictSql,
} from "~/server/domains/email/repo/email-sql";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  createEntityReader,
  createEntityRowFetcher,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import {
  ListContext,
  listPrepare,
} from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
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
const emailScope = listPrepare((db, filters) =>
  resolveEmailScope(db, emailScopeFilters.parse(filters)),
);
const emailScopeFilters = emailFilters.pick({
  purchaseId: true,
  vendorId: true,
  vendorAccountId: true,
});

// One scope record across the three filters (`resolveEmailScope`), so each
// filter that names it applies the same condition.
const inScope = emailScope.predicate((scope) =>
  scope ? emailInScopeSql(scope) : undefined,
);

const scaffold = listScaffold("email", emailTable, {
  derived: {
    // Ties read newest first in either direction.
    linkState: emailScope.value((scope) => [
      emailLinkRankSql(scope),
      { sql: sql`${emailTable.receivedAt}`, direction: "desc" },
    ]),
    scopeLinkState: emailScope.value((scope) => emailLinkStateSql(scope)),
    linked: emailLinkedSql(),
    reviewConflict: emailReviewConflictSql(),
    purchaseId: inScope,
    vendorId: inScope,
    vendorAccountId: inScope,
  },
});

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

export const buildEmailWhere = (
  filters: EmailFilters,
  context: ListContext = ListContext.empty,
) => scaffold.where(filters, { context });

/** Accepted import evidence, else the import Run's own status. */
const OUTCOME = emailImportOutcome.enum;
const importOutcomeSql = sql<string>`CASE
  WHEN EXISTS (${emailAcceptedEvidenceSql()}) THEN ${OUTCOME.imported}::text
  WHEN "Email"."runId" IS NULL THEN ${OUTCOME.not_imported}::text
  ELSE (SELECT CASE
    WHEN r."status" IN (${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed}) THEN ${OUTCOME.failed}::text
    WHEN r."status" = ${runStatus.enum.completed} THEN ${OUTCOME.not_imported}::text
    ELSE ${OUTCOME.importing}::text END
    FROM "Run" r WHERE r."id" = "Email"."runId")
END`;

/** Who reads the list, for `ownedByViewer`; null reads as nobody's. */
type EmailViewer = { userId: string } | null;

const emailRead = (
  db: Database | DrizzleTransaction,
  viewer: EmailViewer,
  scope: EmailPurchaseScope | null = null,
): ListReadOptions<EmailRow> => ({
  media: true,
  // includes-deleted: immutable mail metadata retains its original owner and Run.
  references: {
    ledgerPartyId: { kind: "lookup", missing: "error", includeDeleted: true },
    runId: { kind: "lookup", missing: "null", includeDeleted: true },
  },
  bindings: (bind) => {
    const facts = bind.batch(async ({ rows }) => {
      // includes-deleted: immutable mail metadata keeps naming its owner and Run.
      const [associations, reviews, purchaseLinks, owners] = await Promise.all([
        rows.length === 0
          ? []
          : await unwrapDb(db)
              .select({
                id: emailTable.id,
                linked: emailLinkedSql(),
                reviewConflict: emailReviewConflictSql(),
                importOutcome: importOutcomeSql,
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
          : await unwrapDb(db)
              .select({
                emailId: emailTable.id,
                classification: emailFeedbackClassificationSql(
                  sql`${feedback}`,
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
                feedback,
                and(
                  eq(
                    emailFeedbackObservationIdSql(sql`${feedback}`),
                    sql`${emailClassificationObservation.id}::text`,
                  ),
                  eq(feedback.authority, "member"),
                  eq(feedback.actorUserId, ledgerParty.userId),
                  emailFeedbackHasClassificationSql(sql`${feedback}`),
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
        readEmailPurchaseLinks(
          db,
          rows.map((row) => parseEntityId("email", row.id)),
          scope,
        ),
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
      return {
        reviews: latestReviews,
        linked: new Map(associations.map((row) => [row.id, row.linked])),
        reviewConflict: new Map(
          associations.map((row) => [row.id, row.reviewConflict]),
        ),
        importOutcome: new Map(
          associations.map((row) => [
            row.id,
            emailImportOutcome.parse(row.importOutcome),
          ]),
        ),
        purchaseLinks,
        viewerParties: new Set<string>(owners.map((row) => row.id)),
      };
    });
    return [
      bind(
        emailOut.pick({ displayName: true, relevanceLabel: true }),
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
        emailOut.pick({
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
          linked: loaded.linked.get(row.id) ?? false,
          reviewConflict: loaded.reviewConflict.get(row.id) ?? false,
          purchaseLinks: loaded.purchaseLinks.get(row.id) ?? [],
          ownedByViewer: loaded.viewerParties.has(row.ledgerPartyId),
          linkState: strongestLinkState(loaded.purchaseLinks.get(row.id) ?? []),
          importOutcome: loaded.importOutcome.get(row.id) ?? "not_imported",
          reviewedClassification:
            loaded.reviews.get(row.id)?.classification ?? null,
          reviewedClassificationReason:
            loaded.reviews.get(row.id)?.reason ?? null,
        }),
      ),
    ];
  },
});
const hydrateRead = (
  db: Database | DrizzleTransaction,
  rows: EmailRow[],
  projection: ListProjection,
  viewer: EmailViewer,
  scope: EmailPurchaseScope | null = null,
) =>
  listReadPlan<EmailRow>("email", emailRead(db, viewer, scope)).read(
    db,
    rows,
    projection,
  );

/** The Email list read for one viewer (`ownedByViewer` depends on who reads). */
const emailListRead =
  (viewer: EmailViewer) =>
  async (
    db: Database,
    filters: EmailFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection = { kind: "full" },
    readIntent: ListReadIntent = "page",
  ) => {
    const request = { filters, sorts, pagination, projection, readIntent };
    const context = await scaffold.context(db, request);
    const scope = context.has(emailScope)
      ? context.get(emailScope)
      : await resolveEmailScope(db, filters);
    return scaffold.read(db, request, {
      context,
      read: emailRead(db, viewer, scope),
    });
  };

/** Viewer-free reads (work queues, counts): `ownedByViewer` reads false. */
export const listEmailsRead = emailListRead(null);

const readerFor = (viewer: EmailViewer) =>
  createEntityReader<
    EmailRow,
    EmailOut,
    "email",
    Database | DrizzleTransaction
  >({
    entity: "email",
    fetchById: createEntityRowFetcher(emailTable),
    fromDB: async (db, row) =>
      emailOut.parse(
        (await hydrateRead(db, [row], { kind: "full" }, viewer))[0],
      ),
  });

export const emailRepository = defineRepository("email", {
  get: (ctx: EntityKernelContext, code: string) =>
    readerFor(ctx.actorContext).getByShortcode(ctx.db, code),
  list: (
    ctx: EntityKernelContext,
    filters: EmailFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
  ) =>
    completeListReader(emailOut, emailListRead(ctx.actorContext))(
      ctx.db,
      filters,
      sorts,
      pagination,
    ),
  listRead: (
    ctx: EntityKernelContext,
    filters: EmailFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
    readIntent: ListReadIntent = "page",
  ) =>
    emailListRead(ctx.actorContext)(
      ctx.db,
      filters,
      sorts,
      pagination,
      projection,
      readIntent,
    ),
});
