import type { ActorContext } from "@cubby/schemas/context";
import {
  emailOut,
  type EmailFilters,
  type EmailOut,
} from "@cubby/schemas/email";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { importSourceKind } from "@cubby/schemas/purchase-import";
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  purchase,
  expense,
  product,
  emailClassificationLabel,
  emailClassificationObservation,
  ledgerParty,
  email as emailTable,
} from "~/server/db/schema";
import {
  householdDayRangeConditions,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { listScaffold } from "~/server/repo/list";
import {
  hydrateListRead,
  type ListProjection,
} from "~/server/repo/list-projection";
import { completeListReader } from "~/server/repo/list-read-adapters";
import {
  createEntityReader,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/repo/repository";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { lookupEntityReferences } from "~/server/repo/shortcode-resolver";

type EmailRow = typeof emailTable.$inferSelect;

/**
 * Correlated to the plain Email root table used by the list scaffold. Explicit
 * qualification prevents Drizzle's single-table SELECT from turning the inner
 * identity comparison into a self-comparison. Thread context is not a link.
 * Accepted Orders on any member of the canonical source family survive cache
 * disposal and historical aliases; active lifecycle decisions remain separate.
 */
export const emailAcceptedEvidenceSql = (): SQL => sql`
  SELECT accepted."purchaseId", accepted."checksum" AS "evidenceChecksum", accepted."createdAt" AS "acceptedAt"
  FROM "ImportSourceClaim" identity
  INNER JOIN "ImportSourceClaim" root
    ON root."id" = coalesce(identity."canonicalClaimId", identity."id")
    AND root."canonicalClaimId" IS NULL
    AND root."ledgerPartyId" = identity."ledgerPartyId"
    AND root."kind" = identity."kind"
  INNER JOIN "ImportSourceClaim" family
    ON coalesce(family."canonicalClaimId", family."id") = root."id"
    AND family."ledgerPartyId" = root."ledgerPartyId"
    AND family."kind" = root."kind"
  INNER JOIN "ImportSourceOrder" accepted ON accepted."sourceClaimId" = family."id"
  INNER JOIN "Purchase" p ON p."id" = accepted."purchaseId" AND p."deletedAt" IS NULL
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE identity."ledgerPartyId" = "Email"."ledgerPartyId"
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
    AND (
      (identity."kind" = ${importSourceKind.enum.mail_message}
        AND identity."externalKey" = "Email"."provider" || ':' || "Email"."mailboxId" || ':' || "Email"."messageId")
      OR (identity."kind" = ${importSourceKind.enum.mail_attachment} AND EXISTS (
        SELECT 1 FROM "OrderMailAttachment" attachment
        INNER JOIN "OrderMail" original ON original."id" = attachment."orderMailId"
        WHERE original."id" = "Email"."orderMailId"
          AND original."ledgerPartyId" = "Email"."ledgerPartyId"
          AND identity."externalKey" = "Email"."provider" || ':' || "Email"."mailboxId" || ':' || "Email"."messageId" || ':attachment:' || attachment."providerAttachmentId"
      ))
    )
`;

const emailLifecyclePurchasesSql = (
  decision: "linked" | "dismissed",
): SQL => sql`
  SELECT decision."purchaseId"
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "OrderMailCandidateDecision" decision ON decision."eventId" = event."id"
  INNER JOIN "Purchase" p ON p."id" = decision."purchaseId" AND p."deletedAt" IS NULL
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL AND decision."decision" = ${decision}
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
`;

/** Accepted families and explicit lifecycle decisions share one association policy. */
export const emailPurchaseAssociationsSql = (): SQL => sql`
  SELECT evidence."purchaseId" FROM (${emailAcceptedEvidenceSql()}) evidence
  UNION ${emailLifecyclePurchasesSql("linked")}
`;

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
  const purchasesFor = (associations: SQL) =>
    client
      .select({
        id: purchase.id,
        shortcode: purchase.shortcode,
        orderId: purchase.orderId,
        date: purchase.date,
      })
      .from(purchase)
      .where(
        and(
          notDeleted(purchase),
          sql`
    "Purchase"."id" IN (
      SELECT association."purchaseId" FROM "Email"
      CROSS JOIN LATERAL (${associations}) association
      WHERE "Email"."id" = ${selected.email.id}
    )
  `,
        ),
      )
      .orderBy(desc(purchase.date), purchase.id);
  const purchases = await purchasesFor(emailPurchaseAssociationsSql());
  const purchaseIds = purchases.map((row) => row.id);
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
  const dismissedCandidates = await purchasesFor(
    emailLifecyclePurchasesSql("dismissed"),
  );
  return {
    purchases,
    expenses,
    products,
    samePurchaseEmails,
    threadEmails,
    dismissedCandidates,
  };
}

/** The same SQL owns filter/count membership and the hydrated linked value. */
export const emailLinkedSql = () =>
  sql<boolean>`EXISTS (${emailPurchaseAssociationsSql()})`;
/** Accepted source or lifecycle association; Gmail-thread context never authorizes retention. */
export async function hasAcceptedEmailAssociation(
  db: Database | DrizzleTransaction,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    provider?: string;
  },
): Promise<boolean> {
  const [record] = await unwrapDb(db)
    .select({ linked: emailLinkedSql() })
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

const scaffold = listScaffold("email", emailTable);

export const buildEmailWhere = (filters: EmailFilters) =>
  scaffold.where(filters, [
    ...householdDayRangeConditions(
      emailTable.receivedAt,
      filters.receivedAtFrom,
      filters.receivedAtTo,
    ),
    filters.linked === undefined
      ? undefined
      : eq(emailLinkedSql(), filters.linked),
  ]);

const hydrateRead = async (
  db: Database | DrizzleTransaction,
  rows: EmailRow[],
  projection: ListProjection,
) =>
  hydrateListRead(db, "email", rows, projection, {
    media: true,
    load: async () => {
      // includes-deleted: immutable mail metadata keeps naming its owner and Run.
      const [parties, runs, associations, reviews] = await Promise.all([
        lookupEntityReferences(
          db,
          "ledgerParty",
          rows.map((row) => row.ledgerPartyId),
          { includeDeleted: true },
        ),
        lookupEntityReferences(
          db,
          "run",
          rows.map((row) => row.runId),
          { includeDeleted: true },
        ),
        rows.length === 0
          ? []
          : await unwrapDb(db)
              .select({ id: emailTable.id, linked: emailLinkedSql() })
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
                classification: emailClassificationLabel.classification,
                reason: emailClassificationLabel.reason,
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
                emailClassificationLabel,
                and(
                  eq(
                    emailClassificationLabel.predictionId,
                    emailClassificationObservation.id,
                  ),
                  eq(emailClassificationLabel.actorUserId, ledgerParty.userId),
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
              .orderBy(
                desc(emailClassificationLabel.createdAt),
                desc(emailClassificationLabel.id),
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
        parties,
        runs,
        linked: new Map(associations.map((row) => [row.id, row.linked])),
      };
    },
    mapRow: (row, { loaded }) => {
      const party = loaded.parties.get(row.ledgerPartyId);
      if (!party) throw new Error("Email owner reference is missing");
      return {
        ...row,
        id: parseShortcodeFor("email", row.shortcode),
        displayName: row.subject?.trim() || row.sender?.trim() || row.shortcode,
        ledgerPartyId: party.id,
        ledgerPartyName: party.name,
        runId:
          row.runId === null ? null : (loaded.runs.get(row.runId)?.id ?? null),
        linked: loaded.linked.get(row.id) ?? false,
        reviewedClassification:
          loaded.reviews.get(row.id)?.classification ?? null,
        reviewedClassificationReason:
          loaded.reviews.get(row.id)?.reason ?? null,
      };
    },
  });

export const listEmailsRead = (
  db: Database,
  filters: EmailFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where: buildEmailWhere(filters),
      hydrate: (rows, selected) => hydrateRead(db, rows, selected),
    },
  );

export const listEmails = completeListReader(emailOut, listEmailsRead);
const reader = createEntityReader<
  EmailRow,
  EmailOut,
  "email",
  Database | DrizzleTransaction
>({
  entity: "email",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select()
      .from(emailTable)
      .where(and(eq(emailTable.id, id), notDeleted(emailTable)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) =>
    emailOut.parse((await hydrateRead(db, [row], { kind: "full" }))[0]),
});

export const emailRepository = defineRepository("email", {
  get: onDb(reader.getByShortcode),
  list: listOn(listEmails),
  listRead: listReadOn(listEmailsRead),
});
