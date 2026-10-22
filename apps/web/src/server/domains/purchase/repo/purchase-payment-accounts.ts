/**
 * Purchase → paying FinancialAccount. A member's explicit links are the only
 * stored rows; with none, the order's paying accounts derive on read from its
 * payment evidence (`purchasePayingAccountIdsSql`), so editing card history
 * or the order's member corrects them without a recompute. Re-import
 * never touches a link: no source claim owns it.
 */

import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type FinancialAccountId,
  parseShortcodeFor,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import type { PurchasePaymentAccountOut } from "@cubby/schemas/purchase";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { entityLink, financialAccount, purchase } from "~/server/db/schema";
import { purchasePayingAccountIdsSql } from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import { linkRelationAdapter } from "~/server/entity-kernel/repo/relation-mutation-adapter";
import {
  emptyPreflight,
  type RelationPreflight,
  relationImpact,
  throwRelationRefusal,
} from "~/server/entity-kernel/repo/relation-preflight";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import {
  assertLiveLinkEndpoints,
  linkValues,
  liveLinks,
} from "~/server/generic/entity-links/repo/entity-links";

export async function listPurchasePaymentAccounts(
  db: Database,
  purchaseId: PurchaseId,
): Promise<PurchasePaymentAccountOut[]> {
  const dbc = getDb(db);
  const links = await dbc
    .select({
      code: financialAccount.shortcode,
      name: financialAccount.name,
      linkAttachedAt: entityLink.createdAt,
    })
    .from(entityLink)
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, entityLink.toEntityId),
        notDeleted(financialAccount),
      ),
    )
    .where(
      and(
        eq(entityLink.fromEntityId, purchaseId),
        liveLinks("purchasePaymentAccount"),
      ),
    )
    .orderBy(asc(financialAccount.name), asc(financialAccount.id));
  if (links.length > 0)
    return links.map((row) => ({
      accountId: parseShortcodeFor("financialAccount", row.code),
      accountName: row.name,
      source: "link",
      linkAttachedAt: row.linkAttachedAt,
    }));
  const derived = await dbc
    .select({ code: financialAccount.shortcode, name: financialAccount.name })
    .from(financialAccount)
    .innerJoin(purchase, and(eq(purchase.id, purchaseId), notDeleted(purchase)))
    .where(
      sql`${financialAccount.id} = ANY((${purchasePayingAccountIdsSql('"Purchase"')})::uuid[])`,
    )
    .orderBy(asc(financialAccount.name), asc(financialAccount.id));
  return derived.map((row) => ({
    accountId: parseShortcodeFor("financialAccount", row.code),
    accountName: row.name,
    source: "evidence",
    linkAttachedAt: null,
  }));
}

async function linkedAccountShortcodes(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
): Promise<string[]> {
  const rows = await dbc
    .select({ shortcode: financialAccount.shortcode })
    .from(entityLink)
    .innerJoin(financialAccount, eq(financialAccount.id, entityLink.toEntityId))
    .where(
      and(
        eq(entityLink.fromEntityId, purchaseId),
        liveLinks("purchasePaymentAccount"),
      ),
    )
    .orderBy(asc(financialAccount.shortcode));
  return rows.map((row) => row.shortcode);
}

async function linkedAccountIds(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
  accountIds: readonly FinancialAccountId[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await dbc
    .select({ id: entityLink.toEntityId })
    .from(entityLink)
    .where(
      and(
        eq(entityLink.fromEntityId, purchaseId),
        inArray(entityLink.toEntityId, [...accountIds]),
        liveLinks("purchasePaymentAccount"),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** Sequential queries: shared by the mutation (`tx`) and preview (pool). */
async function preflightAttach(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
  accountIds: readonly FinancialAccountId[],
): Promise<RelationPreflight<FinancialAccountId>> {
  const requested = uniq([...accountIds]);
  const accounts = requested.length
    ? await dbc
        .select({
          id: financialAccount.id,
          shortcode: financialAccount.shortcode,
          deletedAt: financialAccount.deletedAt,
        })
        .from(financialAccount)
        .where(inArray(financialAccount.id, requested))
    : [];
  const live = new Set(
    accounts.filter((row) => row.deletedAt === null).map((row) => row.id),
  );
  const livePurchase = await dbc.query.purchase.findFirst({
    where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
    columns: { id: true },
  });
  const already = await linkedAccountIds(dbc, purchaseId, requested);
  return {
    ...emptyPreflight<FinancialAccountId>(),
    requested,
    parentMissing: !livePurchase,
    missing: requested.filter((id) => !live.has(id)),
    alreadySatisfied: requested.filter((id) => already.has(id)),
    codeById: new Map(accounts.map((row) => [row.id, row.shortcode])),
  };
}

async function preflightDetach(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
  accountIds: readonly FinancialAccountId[],
): Promise<RelationPreflight<FinancialAccountId>> {
  const requested = uniq([...accountIds]);
  const accounts = requested.length
    ? await dbc
        .select({
          id: financialAccount.id,
          shortcode: financialAccount.shortcode,
        })
        .from(financialAccount)
        .where(inArray(financialAccount.id, requested))
    : [];
  const already = await linkedAccountIds(dbc, purchaseId, requested);
  return {
    ...emptyPreflight<FinancialAccountId>(),
    requested,
    alreadySatisfied: requested.filter((id) => !already.has(id)),
    codeById: new Map(accounts.map((row) => [row.id, row.shortcode])),
  };
}

async function attachPaymentAccounts(
  db: Database,
  purchaseId: PurchaseId,
  accountIds: FinancialAccountId[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
  const unique = uniq(accountIds);
  return withTransaction(db, async (tx) => {
    const pre = await preflightAttach(tx, purchaseId, unique);
    if (pre.parentMissing)
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Purchase ${purchaseId} not found`,
      );
    if (pre.missing.length > 0)
      throwRelationRefusal({
        reason: "FINANCIAL_ACCOUNT_NOT_FOUND",
        ids: pre.missing,
        codeById: pre.codeById,
        message: (codes) =>
          `Every linked account must exist and be live. Not live: ${codes}.`,
        items: [
          relationImpact({
            code: "block-relation-target-not-live",
            label: "accounts that are not live",
            description:
              "A FinancialAccount named here does not exist or has been deleted.",
            ids: pre.missing,
          }),
        ],
      });
    const before = await linkedAccountShortcodes(tx, purchaseId);
    await assertLiveLinkEndpoints(tx, "purchasePaymentAccount", [
      purchaseId,
      ...unique,
    ]);
    const inserted = await tx
      .insert(entityLink)
      .values(
        unique.map((accountId) =>
          linkValues("purchasePaymentAccount", purchaseId, accountId),
        ),
      )
      .onConflictDoNothing()
      .returning({ id: entityLink.id });
    const after = await linkedAccountShortcodes(tx, purchaseId);
    if (inserted.length > 0)
      await logAuditEntry(tx, actor, {
        entityKind: "purchase",
        entityId: purchaseId,
        action: "update",
        changes: { paymentAccountIds: { from: before, to: after } },
      });
    return {
      changed: inserted.length,
      attached: after.length,
      alreadySatisfied: unique.length - inserted.length,
    };
  });
}

async function detachPaymentAccounts(
  db: Database,
  purchaseId: PurchaseId,
  accountIds: FinancialAccountId[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
  const unique = uniq(accountIds);
  return withTransaction(db, async (tx) => {
    const before = await linkedAccountShortcodes(tx, purchaseId);
    const removed = await tx
      .update(entityLink)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(entityLink.fromEntityId, purchaseId),
          inArray(entityLink.toEntityId, unique),
          liveLinks("purchasePaymentAccount"),
        ),
      )
      .returning({ id: entityLink.id });
    const after = await linkedAccountShortcodes(tx, purchaseId);
    if (removed.length > 0)
      await logAuditEntry(tx, actor, {
        entityKind: "purchase",
        entityId: purchaseId,
        action: "update",
        changes: { paymentAccountIds: { from: before, to: after } },
      });
    return {
      changed: removed.length,
      attached: after.length,
      alreadySatisfied: unique.length - removed.length,
    };
  });
}

export const purchasePaymentAccountsRelationAdapter = linkRelationAdapter<
  "purchasePaymentAccount",
  { id: string },
  PurchasePaymentAccountOut
>("purchasePaymentAccount", {
  label: "payment-account links",
  target: "FinancialAccount",
  describe: {
    attach:
      "Payment-account links this attach would create; any link replaces the accounts derived from payment evidence.",
    detach:
      "Payment-account links this detach would remove; with none left, paying accounts derive from payment evidence again.",
  },
  list: listPurchasePaymentAccounts,
  targetId: (row) => row.accountId,
  preflight: { attach: preflightAttach, detach: preflightDetach },
  attach: (db, purchaseId, targets, actor) =>
    attachPaymentAccounts(
      db,
      purchaseId,
      targets.map(({ id }) => id),
      actor,
    ),
  detach: detachPaymentAccounts,
});
