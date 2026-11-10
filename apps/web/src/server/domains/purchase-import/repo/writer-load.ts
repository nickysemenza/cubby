import {
  parseEntityId,
  runEntityId,
  userId as userIdSchema,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { requested } from "~/server/db/helpers/requested";
import {
  entityIdentity,
  expense,
  ledgerParty,
  run as runTable,
  vendorAccount,
  importSourceOrder,
  importSourceProduct,
  purchasePaymentEvidence,
  purchase,
  sourceOrderObservation,
} from "~/server/db/schema";
import { effectiveExpenseTradeSql } from "~/server/domains/expense/repo/expense-inheritance";
import { zeroCostOwnershipExitExpensePredicate } from "~/server/domains/product/repo/ownership";
import {
  lockImportSourceClaimFamily,
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "~/server/domains/purchase-import/repo/source-claim-family";

import { normalizedOrderIdSql, normalizeOrderKey } from "./order-identity";
import {
  acceptedSourceExtraction,
  mergedVendorSourceOrder,
} from "./reconciliation-observations";

export async function loadOriginalLineBindings(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
) {
  const sources = await tx
    .select()
    .from(importSourceOrder)
    .where(eq(importSourceOrder.purchaseId, purchaseId));
  const ids = requested(
    sources.map((row) => ({ entity: "importSourceOrder", id: row.id })),
  );
  const bindings = ids.size
    ? await tx
        .select()
        .from(importSourceProduct)
        .where(
          ids.match({
            entity: "importSourceOrder",
            id: sql`${importSourceProduct.sourceOrderId}`,
          }),
        )
    : [];
  return { sources, bindings };
}

export async function loadAcceptedProductChoices(
  tx: DrizzleTransaction,
  order: import("~/server/domains/purchase-import/repo/source-claim-family").LiveSourceOrder,
) {
  const [observation] = order.acceptedObservationId
    ? await tx
        .select()
        .from(sourceOrderObservation)
        .where(eq(sourceOrderObservation.id, order.acceptedObservationId))
    : [];
  const bindings =
    observation?.productBindings ??
    (await tx
      .select()
      .from(importSourceProduct)
      .where(eq(importSourceProduct.sourceOrderId, order.id)));
  const ids = requested(
    bindings.flatMap((row) =>
      row.productId ? [{ entity: "product", id: row.productId }] : [],
    ),
  );
  const identities = ids.size
    ? await tx
        .select({
          id: entityIdentity.id,
          mergedIntoId: entityIdentity.mergedIntoId,
        })
        .from(entityIdentity)
        .where(
          and(
            eq(entityIdentity.kind, "product"),
            ids.match({ entity: "product", id: sql`${entityIdentity.id}` }),
          ),
        )
    : [];
  return { bindings, identities };
}

export async function loadOwnedImportScope(
  tx: DrizzleTransaction,
  input: ImportWriterInput,
  actorUserId: string,
  partyId: typeof ledgerParty.$inferSelect.id,
) {
  const [ownedScope] = await tx
    .select({ partyId: ledgerParty.id })
    .from(ledgerParty)
    .innerJoin(
      runTable,
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.ledgerPartyId, ledgerParty.id),
        eq(runTable.actorUserId, userIdSchema.parse(actorUserId)),
      ),
    )
    .leftJoin(
      vendorAccount,
      input.vendorAccountId
        ? and(
            eq(
              vendorAccount.id,
              parseEntityId("vendorAccount", input.vendorAccountId),
            ),
            eq(vendorAccount.ledgerPartyId, ledgerParty.id),
            eq(vendorAccount.vendorId, parseEntityId("vendor", input.vendorId)),
            notDeleted(vendorAccount),
          )
        : sql`false`,
    )
    .where(
      and(
        eq(ledgerParty.id, partyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
        input.vendorAccountId ? isNotNull(vendorAccount.id) : undefined,
      ),
    )
    .limit(1);
  return ownedScope;
}

export async function loadTargetReviewFacts(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
  noOp: boolean,
) {
  const [priorSourceOrder] = noOp
    ? await tx
        .select({ id: importSourceOrder.id })
        .from(importSourceOrder)
        .where(eq(importSourceOrder.purchaseId, purchaseId))
        .limit(1)
    : [];
  const retainedPayments = await tx
    .select()
    .from(purchasePaymentEvidence)
    .where(eq(purchasePaymentEvidence.purchaseId, purchaseId));
  return { priorSourceOrder, retainedPayments };
}

export async function loadAssignedPurchaseLine(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
  canFillTrade: boolean,
) {
  const [assigned] = canFillTrade
    ? await tx
        .select({ id: expense.id })
        .from(expense)
        .where(
          and(
            eq(expense.purchaseId, purchaseId),
            eq(expense.lineKind, "principal"),
            notDeleted(expense),
            or(
              isNotNull(expense.projectId),
              isNotNull(expense.trade),
              isNotNull(effectiveExpenseTradeSql()),
            ),
          ),
        )
        .limit(1)
    : [];
  return assigned;
}

export async function loadOrderedPurchases(
  tx: DrizzleTransaction,
  vendorId: ReturnType<typeof parseEntityId<"vendor">>,
  orderId: string | null,
) {
  if (!orderId) return { matches: [], lined: [] };
  const matches = await tx.query.purchase.findMany({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(
            eq(purchase.vendorId, vendorId),
            eq(
              normalizedOrderIdSql(purchase.orderId),
              normalizeOrderKey(orderId),
            ),
            notDeleted(purchase),
          ),
        ),
    },
  });
  const ids = requested(
    matches.map((row) => ({ entity: "purchase", id: row.id })),
  );
  const lined =
    matches.length > 1
      ? await tx
          .selectDistinct({ purchaseId: expense.purchaseId })
          .from(expense)
          .where(
            and(
              ids.match({ entity: "purchase", id: sql`${expense.purchaseId}` }),
              notDeleted(expense),
            ),
          )
      : [];
  return { matches, lined };
}

export async function loadChosenPurchase(
  tx: DrizzleTransaction,
  selectedId: string | null | undefined,
) {
  return selectedId
    ? tx.query.purchase.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(
                eq(purchase.id, parseEntityId("purchase", selectedId)),
                notDeleted(purchase),
              ),
            ),
        },
      })
    : undefined;
}

export async function lockPurchaseTarget(
  tx: DrizzleTransaction,
  target: typeof purchase.$inferSelect,
) {
  const [locked] = await tx
    .select()
    .from(purchase)
    .where(and(eq(purchase.id, target.id), notDeleted(purchase)))
    .for("update");
  return locked;
}

export async function lockPurchaseExpenses(
  tx: DrizzleTransaction,
  target: typeof purchase.$inferSelect,
) {
  await tx
    .select({ id: expense.id })
    .from(expense)
    .where(
      and(
        eq(expense.purchaseId, target.id),
        eq(expense.economicRole, "vendor"),
        notDeleted(expense),
      ),
    )
    .for("update");
}

export async function loadAcceptedPurchase(
  tx: DrizzleTransaction,
  order: import("~/server/domains/purchase-import/repo/source-claim-family").LiveSourceOrder,
  vendorId: string,
) {
  return tx.query.purchase.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(
            eq(purchase.id, order.purchaseId),
            eq(purchase.vendorId, parseEntityId("vendor", vendorId)),
            notDeleted(purchase),
          ),
        ),
    },
  });
}

export async function loadAcceptedPaymentFacts(
  tx: DrizzleTransaction,
  order: import("~/server/domains/purchase-import/repo/source-claim-family").LiveSourceOrder,
) {
  const accepted = await acceptedSourceExtraction(tx, order);
  const retainedPayments = await tx
    .select()
    .from(purchasePaymentEvidence)
    .where(
      and(
        eq(purchasePaymentEvidence.sourceClaimId, order.sourceClaimId),
        eq(purchasePaymentEvidence.purchaseId, order.purchaseId),
      ),
    );
  return { accepted, retainedPayments };
}

export async function lockAndLoadSourceFamily(
  tx: DrizzleTransaction,
  identity: Parameters<typeof lockImportSourceClaimFamily>[1],
) {
  return (
    (await readImportSourceClaimFamily(tx, identity, {
      lock: "update",
      writable: true,
    })) ?? (await lockImportSourceClaimFamily(tx, identity))
  );
}

export async function lockAndLoadSourceOrder(
  tx: DrizzleTransaction,
  family: Awaited<ReturnType<typeof lockAndLoadSourceFamily>>,
  orderKey: string,
  vendorId: string,
) {
  return (
    (await readSourceFamilyOrder(tx, family, orderKey, "update"))
      ?.association ??
    (await mergedVendorSourceOrder(
      tx,
      family.members.map((row) => row.id),
      orderKey,
      parseEntityId("vendor", vendorId),
    ))
  );
}

export async function loadUnlinkedProducts(
  tx: DrizzleTransaction,
  productIds: readonly string[],
) {
  const ids = requested(productIds.map((id) => ({ entity: "product", id })));
  return ids.size
    ? tx
        .select({ id: expense.id })
        .from(expense)
        .where(
          and(
            isNull(expense.purchaseId),
            ids.match({ entity: "product", id: sql`${expense.productId}` }),
            eq(expense.lineKind, "principal"),
            eq(expense.economicRole, "vendor"),
            sql`${zeroCostOwnershipExitExpensePredicate()} IS NOT TRUE`,
            notDeleted(expense),
          ),
        )
        .limit(1)
    : [];
}

export async function loadClassifiedPurchaseLines(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
) {
  return tx.query.expense.findMany({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(eq(expense.purchaseId, purchaseId), notDeleted(expense)),
        ),
    },
  });
}

export async function loadRetainedTender(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
  sourceClaimId: string,
) {
  return tx
    .select()
    .from(purchasePaymentEvidence)
    .where(
      and(
        eq(purchasePaymentEvidence.purchaseId, purchaseId),
        eq(purchasePaymentEvidence.sourceClaimId, sourceClaimId),
      ),
    );
}

export async function loadAssociationRun(
  tx: DrizzleTransaction,
  input: import("./writer").ImportSourceAssociationInput,
  partyId: typeof ledgerParty.$inferSelect.id,
) {
  const [owned] = await tx
    .select({ id: runTable.id })
    .from(runTable)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, runTable.ledgerPartyId),
        eq(ledgerParty.userId, runTable.actorUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.ledgerPartyId, partyId),
      ),
    )
    .limit(1);
  return owned;
}

export async function loadAssociationTarget(
  tx: DrizzleTransaction,
  input: import("./writer").ImportSourceAssociationInput,
  purchaseId: PurchaseId,
) {
  const [target] = await tx
    .select({ id: purchase.id })
    .from(purchase)
    .where(
      and(
        eq(purchase.id, purchaseId),
        eq(purchase.vendorId, parseEntityId("vendor", input.vendorId)),
        notDeleted(purchase),
      ),
    )
    .limit(1);
  return target;
}

export async function loadAssociationAccount(
  tx: DrizzleTransaction,
  input: import("./writer").ImportSourceAssociationInput,
  partyId: typeof ledgerParty.$inferSelect.id,
) {
  const [ownedAccount] = await tx
    .select({ id: vendorAccount.id })
    .from(vendorAccount)
    .where(
      and(
        eq(
          vendorAccount.id,
          parseEntityId("vendorAccount", input.vendorAccountId!),
        ),
        eq(vendorAccount.ledgerPartyId, partyId),
        eq(vendorAccount.vendorId, parseEntityId("vendor", input.vendorId)),
        notDeleted(vendorAccount),
      ),
    )
    .limit(1);
  return ownedAccount;
}
