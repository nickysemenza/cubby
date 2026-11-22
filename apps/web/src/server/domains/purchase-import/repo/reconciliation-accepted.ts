import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  commitAcceptedSourceOrderReconciliationInput,
  importWriterInput,
  commitAcceptedSourceOrderReconciliationOut,
  prepareSourceOrderReconciliationOut,
  type CommitAcceptedSourceOrderReconciliationInput,
  type ExtractedPurchaseLine,
  type PrepareSourceOrderReconciliationInput,
} from "@cubby/schemas/purchase-import";
import { minorToMoney } from "@cubby/shared";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { notDeleted, withTransaction } from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import { requested } from "~/server/db/helpers/requested";
import { evidenceBinding, recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  auditLog,
  expense,
  expenseAttribution,
  financialTransaction,
  financialTransactionAllocation,
  ledgerTransfer,
  importSourceOrder,
  importSourceClaim,
  importSourceProduct,
  ledgerParty,
  ledgerSourceClaim,
  purchase,
  product,
  sourceOrderObservation,
} from "~/server/db/schema";
import { updatePurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import {
  importedLineMatchesExpense,
  sameLineTitle,
} from "~/server/domains/purchase-import/policy/import-lines";
import { importLineWritePolicy } from "~/server/domains/purchase-import/policy/import-plan";
import { orderEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
import {
  acceptedOrders,
  acceptedOrdersBoundTo,
  acceptedOrderLinesSql,
} from "~/server/domains/purchase-import/repo/accepted-order-read";
import {
  isLiveSourceOrder,
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "~/server/domains/purchase-import/repo/source-claim-family";
import { unpricedForeignExpenseSql } from "~/server/domains/purchase-import/repo/writer-policy";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  decide,
  householdWrite,
  reconcileNow,
  effectiveBindings,
} from "~/server/kernel/api";
import { sha256CanonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import {
  freezePreparedNewProductLine,
  readAcceptedPreparation,
  sourceItemConflicts,
  acceptedSiblingConflicts,
} from "./reconciliation-new-product";

type Resolution = CommitAcceptedSourceOrderReconciliationInput["resolution"];
const acceptedProductReceipt = z.object({
  acceptedSourceProduct: z.object({
    to: z.object({
      sourceOrderId: z.uuid(),
      lineIndex: z.number().int().nonnegative(),
      productId: z.uuid(),
    }),
  }),
});
type OriginalReview = {
  associationId: string;
  preparation: NonNullable<
    CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"]
  >;
  observationId: string;
  previousObservationId: string | null;
  previousChecksum: string;
};
const originalReviewReceipt = z.object({
  reviewedOriginalPreparation: z.object({
    to: commitAcceptedSourceOrderReconciliationInput.shape.reviewedPreparation
      .unwrap()
      .extend({
        sourceOrderId: z.uuid(),
        acceptedObservationId: z.uuid(),
      }),
  }),
});

/** Resolve current facts and retained aliases under their actual member and canonical family. */
async function acceptedObservation(
  db: Database,
  id: string,
  actor: ActorContext,
  resolution: Resolution,
  preparation?: CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"],
) {
  const q = repositoryQueries(db);
  let promotedObservationId: string | null = null;
  let originalReview: OriginalReview | null = null;
  let canonicalSource: Pick<
    typeof importSourceClaim.$inferSelect,
    "kind" | "externalKey"
  > | null = null;
  const [alias] = await q
    .select({ association: importSourceOrder, claim: importSourceClaim })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .where(eq(importSourceOrder.id, id));
  if (alias) {
    if (!isLiveSourceOrder(alias.association))
      throw new Error(
        "The accepted source's Purchase was deleted; review its evidence",
      );
    const family = await readImportSourceClaimFamily(q, alias.claim);
    if (!family)
      throw new Error("The accepted source canonical family is unavailable");
    canonicalSource = {
      kind: family.root.kind,
      externalKey: family.root.externalKey,
    };
    await readSourceFamilyOrder(q, family, alias.association.orderKey);
    if (preparation) {
      const association = alias.association;
      const review = await withTransaction(db, async (tx) => {
        const { canonicalizeReviewedLegacyOriginal, recordReviewedOriginal } =
          await import("~/server/domains/purchase-import/repo/reconciliation-original-review");
        const canonical = await canonicalizeReviewedLegacyOriginal(
          tx,
          association,
          family,
          preparation,
          actor,
        );
        canonicalSource = {
          kind: canonical.family.root.kind,
          externalKey: canonical.family.root.externalKey,
        };
        const owned = await readSourceFamilyOrder(
          tx,
          canonical.family,
          association.orderKey,
          "update",
        );
        if (
          !owned ||
          owned.association.id !== association.id ||
          owned.association.purchaseId !== association.purchaseId
        )
          throw new Error(
            "Reviewed source family must still name the same Purchase",
          );
        const observation = await recordReviewedOriginal(
          tx,
          owned.association,
          canonical.family,
          preparation,
          actor,
          canonical.reviewedLegacyChecksum,
        );
        if (association.acceptedObservationId) {
          const [accepted] = await tx
            .select()
            .from(sourceOrderObservation)
            .where(
              eq(sourceOrderObservation.id, association.acceptedObservationId),
            );
          const receipts = await tx
            .select({ changes: auditLog.changes })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.entityKind, "purchase"),
                eq(auditLog.entityId, association.purchaseId),
              ),
            );
          const sameReview = receipts.some(({ changes }) => {
            const receipt = originalReviewReceipt.safeParse(changes);
            return (
              receipt.success &&
              receipt.data.reviewedOriginalPreparation.to.sourceOrderId ===
                id &&
              receipt.data.reviewedOriginalPreparation.to.run ===
                preparation.run &&
              receipt.data.reviewedOriginalPreparation.to.stableOrderId ===
                preparation.stableOrderId
            );
          });
          if (
            !accepted ||
            !sameReview ||
            (await sha256CanonicalJson(
              jsonSnapshot.parse(accepted.extraction),
            )) !==
              (await sha256CanonicalJson(
                jsonSnapshot.parse(observation.extraction),
              ))
          )
            throw new Error(
              "A known accepted original uses its existing immutable observation",
            );
        }
        return observation;
      });
      promotedObservationId = review.id;
      originalReview = {
        associationId: association.id,
        preparation,
        observationId: review.id,
        previousObservationId: association.acceptedObservationId,
        previousChecksum: association.checksum,
      };
    }
    if (!alias.association.acceptedObservationId && !promotedObservationId) {
      if (!resolution.lines.some((binding) => binding.newProduct)) {
        const { promoteHistoricalAcceptedObservation } =
          await import("~/server/domains/purchase-import/repo/reconciliation-observations");
        promotedObservationId = await withTransaction(db, (tx) =>
          promoteHistoricalAcceptedObservation(tx, alias.association.id),
        );
      }
      if (!promotedObservationId)
        throw new Error(
          "The accepted original immutable evidence is unknown; review its original",
        );
    }
  }
  if (preparation && !alias)
    throw new Error(
      "A known accepted original uses its existing immutable observation",
    );
  const observationId =
    promotedObservationId ?? alias?.association.acceptedObservationId ?? id;
  const [owned] = await q
    .select({ observation: sourceOrderObservation })
    .from(sourceOrderObservation)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, sourceOrderObservation.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        notDeleted(ledgerParty),
      ),
    )
    .where(eq(sourceOrderObservation.id, observationId));
  if (!owned) throw new Error("Accepted order not found for this member");
  const fact = owned.observation;
  return {
    fact,
    originalReview,
    canonicalSource: canonicalSource ?? {
      kind: fact.sourceKind,
      externalKey: fact.sourceExternalKey,
    },
  };
}

/** A partial Product choice still validates the complete accepted item roster. */
async function acceptedItemCorrespondence(
  db: Database,
  fact: typeof sourceOrderObservation.$inferSelect,
  target: typeof purchase.$inferSelect,
  expenses: readonly (typeof expense.$inferSelect)[],
  resolution: Resolution,
) {
  const q = repositoryQueries(db);
  const candidate = fact.extraction.candidate;
  if (!candidate)
    throw new Error("The accepted source has no readable item evidence");
  const foreign =
    candidate.currency !== null &&
    /^[A-Z]{3}$/.test(candidate.currency) &&
    candidate.currency !== "USD";
  if (candidate.currency !== "USD" && !foreign)
    throw new Error("Product association requires explicit source currency");
  const correspondence = await q.execute<{
    lineIndex: number;
    expenseId: string | null;
  }>(sql`
    SELECT "lineIndex","expenseId" FROM ${acceptedOrderLinesSql}
    WHERE "sourceOrderId"=${fact.id}::uuid`);
  const explicitRoster =
    resolution.lines.length === candidate.lines.length &&
    new Set(resolution.lines.map((row) => row.lineIndex)).size ===
      candidate.lines.length &&
    resolution.lines.every((row) => row.expenseId !== null) &&
    new Set(resolution.lines.map((row) => row.expenseId)).size ===
      candidate.lines.length;
  const usedExpenses = new Set<string>();
  for (const row of correspondence.rows) {
    const line = candidate.lines[row.lineIndex];
    const matching = line
      ? expenses.filter(
          (expense) =>
            expense.economicRole === "vendor" &&
            importedLineMatchesExpense(
              {
                title: expense.name,
                amount:
                  expense.cost === null ? null : minorToMoney(expense.cost),
                lineKind: expense.lineKind,
                productQuantity: expense.productQuantity,
              },
              line,
              foreign || line.amount === null ? "unknown" : "USD",
            ),
        )
      : [];
    const requested = resolution.lines.find(
      (binding) => binding.lineIndex === row.lineIndex,
    );
    const selected = row.expenseId
      ? expenses.find((expense) => expense.id === row.expenseId)
      : requested?.expenseId
        ? expenses.find((expense) => expense.shortcode === requested.expenseId)
        : matching.length === 1
          ? matching[0]
          : undefined;
    if (
      !line ||
      !selected ||
      usedExpenses.has(selected.id) ||
      selected.lineBasis !== "item_line" ||
      selected.economicRole !== "vendor" ||
      !importedLineMatchesExpense(
        {
          title: selected.name,
          amount: selected.cost === null ? null : minorToMoney(selected.cost),
          lineKind: selected.lineKind,
          productQuantity: selected.productQuantity,
        },
        line,
        foreign || line.amount === null ? "unknown" : "USD",
      )
    )
      throw new Error(
        `Accepted Product review requires an exact current item Expense binding and must preserve its money; title matches: ${line && selected ? sameLineTitle(line.title, selected.name) : false}`,
      );
    // Identical printed lines keep multiplicity. A complete explicit roster
    // identifies each acquisition; partial title matching cannot choose one.
    if (
      matching.length !== 1 &&
      !(explicitRoster && requested?.expenseId === selected.shortcode)
    )
      throw new Error(
        "The accepted item binding is ambiguous; review the complete item roster",
      );
    row.expenseId = selected.id;
    usedExpenses.add(selected.id);
  }
  if (correspondence.rows.length !== candidate.lines.length)
    throw new Error("The accepted item mapping is missing or ambiguous");
  const [ledgerClaim] = await q
    .select({ id: ledgerSourceClaim.id })
    .from(ledgerSourceClaim)
    .innerJoin(expense, eq(expense.id, ledgerSourceClaim.expenseId))
    .where(eq(expense.purchaseId, target.id))
    .limit(1);
  if (ledgerClaim)
    throw new Error(
      "Accepted Product review cannot replace ledger source claims or ownership",
    );
  if (
    foreign &&
    (candidate.sourceEvent === "refunded" ||
      candidate.sourceEvent === "cancelled" ||
      candidate.lines.some(
        (line) =>
          line.lineKind === "principal" &&
          line.amount !== null &&
          line.amount < 0,
      ))
  )
    throw new Error(
      "Foreign reversals require reviewed accounting reconciliation",
    );
  if (
    new Set(resolution.lines.map((row) => row.lineIndex)).size !==
      resolution.lines.length ||
    new Set(resolution.lines.map((row) => row.expenseId)).size !==
      resolution.lines.length
  )
    throw new Error(
      "Each accepted item must name a distinct source line and Expense",
    );
  return { foreign, correspondence };
}

async function acceptedState(
  db: Database,
  id: string,
  actor: ActorContext,
  resolution: Resolution,
  preparation?: CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"],
) {
  const q = repositoryQueries(db);
  const { fact, originalReview, canonicalSource } = await acceptedObservation(
    db,
    id,
    actor,
    resolution,
    preparation,
  );
  const observationId = fact.id;
  const bindings = await q
    .select()
    .from(evidenceBinding)
    .where(
      and(
        eq(evidenceBinding.factKind, "orderObservation"),
        eq(evidenceBinding.factId, observationId),
      ),
    );
  const binding = effectiveBindings(
    bindings.map((row) => ({
      fact: { kind: row.factKind, id: row.factId },
      basis: row.basis,
      eventKey: row.eventKey,
      scope: { kind: row.scopeKind, key: row.scopeKey },
    })),
  )[0];
  let scope =
    binding?.basis === "baseline" && binding.scope.kind === "purchaseEvent"
      ? binding.scope.key
      : (binding?.eventKey ?? orderEventKey(fact));
  const records = await q
    .select()
    .from(recordKey)
    .where(
      and(
        eq(recordKey.scopeKind, "purchaseEvent"),
        eq(recordKey.scopeKey, scope),
        eq(recordKey.entity, "purchase"),
        isNull(recordKey.mergedAt),
        isNull(recordKey.rejectedAt),
      ),
    );
  const purchaseId = records[0]?.entityId ?? fact.purchaseId;
  if (!purchaseId)
    throw new Error("The order is waiting for its purchase identity");
  const [target] = await q
    .select()
    .from(purchase)
    .where(
      and(
        (
          await import("~/server/domains/purchase-import/repo/reconciliation-observations")
        ).sourceObservationIdentitySql(
          "purchase",
          sql`${parseEntityId("purchase", purchaseId)}::uuid`,
          purchase.id,
        ),
        notDeleted(purchase),
      ),
    );
  if (!target) throw new Error("The accepted Purchase is not live");
  const owners = await q
    .select({ scopeKey: recordKey.scopeKey })
    .from(recordKey)
    .where(
      and(
        eq(recordKey.entity, "purchase"),
        eq(recordKey.entityId, target.id),
        eq(recordKey.scopeKind, "purchaseEvent"),
        isNull(recordKey.mergedAt),
        isNull(recordKey.rejectedAt),
      ),
    );
  const [owner] = owners;
  if (owners.length !== 1 || !owner)
    throw new Error(
      "The accepted Purchase has no unique live reconciliation owner",
    );
  scope = owner.scopeKey;
  const expenses = await q
    .select()
    .from(expense)
    .where(and(eq(expense.purchaseId, target.id), notDeleted(expense)));
  const { foreign, correspondence } = await acceptedItemCorrespondence(
    db,
    fact,
    target,
    expenses,
    resolution,
  );
  const appliedNewProducts = new Set<number>();
  const { sourceObservationIdentityMatches } =
    await import("./reconciliation-observations");
  if (
    !target.vendorId ||
    !(await sourceObservationIdentityMatches(
      q,
      "vendor",
      fact.vendorId,
      target.vendorId,
    ))
  )
    throw new Error(
      "The accepted source and Purchase have different Vendor identities",
    );
  for (const binding of resolution.lines) {
    const line = fact.extraction.candidate?.lines[binding.lineIndex];
    const selected = expenses.find(
      (row) => row.shortcode === binding.expenseId,
    );
    if (
      !line ||
      !selected ||
      selected.lineBasis !== "item_line" ||
      selected.economicRole !== "vendor" ||
      !importedLineMatchesExpense(
        {
          title: selected.name,
          amount: selected.cost === null ? null : minorToMoney(selected.cost),
          lineKind: selected.lineKind,
          productQuantity: selected.productQuantity,
        },
        line,
        foreign || line.amount === null ? "unknown" : "USD",
      )
    )
      throw new Error(
        "Review the exact accepted item amount, quantity and Expense before linking a Product",
      );
    if (
      (binding.productId || binding.newProduct) &&
      line.lineKind !== "principal"
    )
      throw new Error("Only principal item lines can carry a Product");
    if (binding.productId && binding.newProduct)
      throw new Error("Choose one Product identity");
    if (selected.productId) {
      let requested = binding.productId
        ? await resolveOrThrow(db, "product", binding.productId)
        : null;
      if (binding.newProduct) {
        const receipts = await q
          .select({ changes: auditLog.changes })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.entityKind, "expense"),
              eq(auditLog.entityId, selected.id),
            ),
          );
        for (const receipt of receipts) {
          const parsed = acceptedProductReceipt.safeParse(receipt.changes);
          if (!parsed.success) continue;
          const recorded = parsed.data.acceptedSourceProduct.to;
          if (
            recorded.sourceOrderId === id &&
            recorded.lineIndex === binding.lineIndex &&
            (await sourceObservationIdentityMatches(
              q,
              "product",
              recorded.productId,
              selected.productId,
            ))
          ) {
            requested = selected.productId;
            appliedNewProducts.add(binding.lineIndex);
            break;
          }
        }
      }
      if (
        !requested ||
        !(await sourceObservationIdentityMatches(
          q,
          "product",
          selected.productId,
          requested,
        ))
      )
        throw new Error(
          "Accepted Product association must preserve the selected Product bound to this item",
        );
    }
  }
  return {
    fact,
    scope,
    target,
    expenses,
    appliedNewProducts: [...appliedNewProducts],
    correspondence: correspondence.rows,
    originalReview,
    canonicalSource,
    vendorId: target.vendorId,
  };
}

/** Preview and commit carry the same complete, exact item roster without replacing omitted member choices. */
async function completeAcceptedResolution(
  db: Database,
  state: Awaited<ReturnType<typeof acceptedState>>,
  input: Resolution,
) {
  const q = repositoryQueries(db);
  const ids = [
    ...new Set(
      state.expenses.flatMap((row) => (row.productId ? [row.productId] : [])),
    ),
  ];
  const products = ids.length
    ? await q
        .select({ id: product.id, shortcode: product.shortcode })
        .from(product)
        .where(
          and(
            notDeleted(product),
            requested(
              ids.map((id) => ({ entity: "product" as const, id })),
            ).match({ entity: "product", id: sql`${product.id}` }),
          ),
        )
    : [];
  const codes = new Map(
    products.map((row) => [
      row.id,
      parseShortcodeFor("product", row.shortcode),
    ]),
  );
  const lines = [...input.lines];
  const { sourceObservationIdentityMatches } =
    await import("~/server/domains/purchase-import/repo/reconciliation-observations");
  for (const binding of state.correspondence) {
    if (lines.some((line) => line.lineIndex === binding.lineIndex)) continue;
    const selected = state.expenses.find((row) => row.id === binding.expenseId);
    if (!selected)
      throw new Error("Untouched accepted item binding is missing");
    const originalProduct = state.fact.productBindings.find(
      (line) => line.lineIndex === binding.lineIndex,
    )?.productId;
    if (
      (selected.productId && !codes.has(selected.productId)) ||
      (originalProduct &&
        (!selected.productId ||
          !(await sourceObservationIdentityMatches(
            q,
            "product",
            originalProduct,
            selected.productId,
          ))))
    )
      throw new Error(
        "Untouched accepted Product binding changed; review an explicit complete roster",
      );
    lines.push({
      lineIndex: binding.lineIndex,
      expenseId: parseShortcodeFor("expense", selected.shortcode),
      productId: selected.productId
        ? (codes.get(selected.productId) ?? null)
        : null,
    });
  }
  return { resolution: { ...input, lines }, codes };
}

/** Product creation must retain the original preparation and cannot claim an item owned by ledger evidence. */
async function validateAcceptedPreparation(
  db: Database,
  state: Awaited<ReturnType<typeof acceptedState>>,
  resolution: Resolution,
  selection?: CommitAcceptedSourceOrderReconciliationInput["reviewedPreparation"],
) {
  const prepared = new Map<number, string>();
  const requests = resolution.lines.filter(
    (binding) =>
      binding.newProduct &&
      !state.appliedNewProducts.includes(binding.lineIndex),
  );
  if (!requests.length) return prepared;
  if (!state.fact.ledgerPartyId)
    throw new Error("Accepted preparation ownership is unknown");
  const ownerId = state.fact.ledgerPartyId;
  return withTransaction(db, async (tx) => {
    const retainedSources = await tx
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.purchaseId, state.target.id));
    const retainedBindings = await tx
      .select({ binding: importSourceProduct })
      .from(importSourceProduct)
      .innerJoin(
        importSourceOrder,
        eq(importSourceOrder.id, importSourceProduct.sourceOrderId),
      )
      .where(eq(importSourceOrder.purchaseId, state.target.id));
    const targetOrders = acceptedOrdersBoundTo((id) => eq(id, state.target.id));
    const sources = await tx
      .select()
      .from(targetOrders)
      .orderBy(desc(targetOrders.createdAt), desc(targetOrders.id));
    const heads = new Map<string, (typeof sources)[number]>();
    const retainedObservationIds = new Set(
      retainedSources.map((source) => source.acceptedObservationId),
    );
    for (const source of sources) {
      if (retainedObservationIds.has(source.id)) continue;
      const key = JSON.stringify([
        source.sourceKind,
        source.sourceExternalKey,
        source.orderKey,
      ]);
      if (!heads.has(key)) heads.set(key, source);
    }
    const siblings = [...heads.values()].filter(
      (source) =>
        source.sourceKind !== state.fact.sourceKind ||
        source.sourceExternalKey !== state.fact.sourceExternalKey ||
        source.orderKey !== state.fact.orderKey,
    );
    const { order, lines } = await readAcceptedPreparation(
      tx,
      state.fact,
      {
        kind: state.fact.sourceKind,
        externalKey: state.fact.sourceExternalKey,
      },
      ownerId,
      state.vendorId,
      selection,
    );
    for (const binding of requests) {
      const line = state.fact.extraction.candidate?.lines[binding.lineIndex];
      const selected = state.expenses.find(
        (row) => row.shortcode === binding.expenseId,
      );
      if (!line || !selected) throw new Error("The accepted item is missing");
      const retainedConflicts = await acceptedSiblingConflicts(
        tx,
        {
          observation: state.fact,
          sourceOrders: retainedSources.filter(isLiveSourceOrder),
          productBindings: retainedBindings.map(({ binding }) => binding),
        },
        line,
      );
      const conflicts = sourceItemConflicts(
        state.fact.extraction.candidate,
        line,
        siblings.map((source) => ({
          candidate: source.extraction.candidate,
          bindings: source.productBindings.filter(
            (binding) => binding.productId !== null,
          ),
        })),
      );
      if (
        conflicts.competingBindings ||
        conflicts.contradicting ||
        retainedConflicts.competingBindings ||
        retainedConflicts.contradicting
      )
        throw new Error(
          `New Product review has competing accepted source bindings: ${conflicts.competingBindings + retainedConflicts.competingBindings}; contradicting accepted sources: ${conflicts.contradicting + retainedConflicts.contradicting}`,
        );
      const exact = state.expenses.filter(
        (row) =>
          row.economicRole === "vendor" &&
          row.lineBasis === "item_line" &&
          importedLineMatchesExpense(
            {
              title: row.name,
              amount: row.cost === null ? null : minorToMoney(row.cost),
              lineKind: row.lineKind,
              productQuantity: row.productQuantity,
            },
            line,
            state.fact.extraction.candidate?.currency === "USD" &&
              line.amount !== null
              ? "USD"
              : "unknown",
          ),
      );
      const [claim] = await tx
        .select({ id: ledgerSourceClaim.id })
        .from(ledgerSourceClaim)
        .where(eq(ledgerSourceClaim.expenseId, selected.id))
        .limit(1);
      if (exact.length !== 1 || exact[0]?.id !== selected.id || claim)
        throw new Error(
          "New Product review requires one exact item without competing ledger ownership",
        );
      prepared.set(
        binding.lineIndex,
        await freezePreparedNewProductLine(
          tx,
          line,
          state.vendorId,
          binding,
          order,
          lines,
        ),
      );
    }
    return prepared;
  });
}

/** Use the existing identity guard, issuer locks and identifier learner for reviewed catalog creation. */
async function resolveAcceptedNewProducts(
  db: Database,
  state: Awaited<ReturnType<typeof acceptedState>>,
  resolution: Resolution,
  actor: ActorContext,
) {
  const { lineProductResolver } =
    await import("~/server/domains/purchase-import/repo/writer");
  const requests: {
    binding: Resolution["lines"][number];
    line: ExtractedPurchaseLine;
    decision: import("~/server/domains/purchase-import/repo/writer-decisions").LineIdentityDecision;
  }[] = [];
  for (const binding of resolution.lines) {
    if (
      !binding.newProduct ||
      state.appliedNewProducts.includes(binding.lineIndex)
    )
      continue;
    const line = state.fact.extraction.candidate?.lines[binding.lineIndex];
    if (!line) throw new Error("The reviewed Product item is missing");
    const distinctFrom = [];
    for (const distinct of binding.newProduct.distinctFrom ?? [])
      distinctFrom.push({
        ...distinct,
        productId: await resolveOrThrow(db, "product", distinct.productId),
      });
    const decision: import("~/server/domains/purchase-import/repo/writer-decisions").LineIdentityDecision =
      {
        productId: null,
        promote: true,
        variantDoubt: false,
        unresolvedReason: null,
        probability: 1,
        lineKind: "principal",
        kitKind: "single",
        reversalKind: null,
        distinctFrom,
      };
    requests.push({ binding, line, decision });
  }
  return withTransaction(db, async (tx) => {
    const resolver = lineProductResolver(tx, state.vendorId, requests, {
      actor,
    });
    const resolved = new Map<
      number,
      import("@cubby/schemas/identifiers").ProductId
    >();
    for (const request of requests) {
      const id = await resolver.resolve(request.line, request.decision);
      if (!id) throw new Error("The reviewed new Product was not created");
      resolved.set(request.binding.lineIndex, id);
    }
    await resolver.flush();
    return resolved;
  });
}

/** Preserve the reviewed item identity before a field write can reconcile a merged money scope. */
async function retainAcceptedCorrespondence(
  db: Database,
  state: Awaited<ReturnType<typeof acceptedState>>,
  actor: ActorContext,
) {
  const event = orderEventKey(state.fact);
  const scope = { kind: "purchaseEvent", key: state.scope };
  const decisions: import("~/server/kernel/api").DecisionInput[] = [
    {
      channel: "assignment",
      kind: "set",
      subject: event,
      field: "purchaseId",
      value: state.target.id,
      scopes: [scope],
    },
  ];
  for (const binding of state.correspondence) {
    if (!binding.expenseId)
      throw new Error("The reviewed accepted item identity is missing");
    const line = state.fact.productBindings.find(
      (row) => row.lineIndex === binding.lineIndex,
    );
    decisions.push({
      channel: "assignment",
      kind: "set",
      subject: `purchaseEvent:${event}`,
      field: `line-record:${line?.stableLineId ?? binding.lineIndex}`,
      value: binding.expenseId,
      scopes: [scope],
    });
  }
  await decide(db, actor, decisions);
}

/** A member review appends binding evidence; it never edits the original source observation. */
async function recordAcceptedProductReview(
  db: Database,
  state: Awaited<ReturnType<typeof acceptedState>>,
  actor: ActorContext,
  resolution: Resolution,
) {
  if (!state.fact.ledgerPartyId)
    throw new Error("The accepted source owner is unknown");
  const { appendOrderEvidence, orderEventKey } =
    await import("~/server/domains/purchase-import/repo/order-evidence");
  const { settleOrderEvidence } =
    await import("~/server/domains/purchase-import/repo/settle-order-evidence");
  const q = repositoryQueries(db);
  const [claim] = state.fact.sourceClaimId
    ? await q
        .select({ runId: importSourceClaim.firstRunId })
        .from(importSourceClaim)
        .where(
          and(
            eq(importSourceClaim.id, state.fact.sourceClaimId),
            eq(importSourceClaim.ledgerPartyId, state.fact.ledgerPartyId),
            eq(importSourceClaim.kind, state.fact.sourceKind),
            eq(importSourceClaim.externalKey, state.fact.sourceExternalKey),
          ),
        )
    : [];
  const runId = state.fact.runId ?? claim?.runId;
  if (!runId)
    throw new Error("The accepted source has no retained Run provenance");
  const current = await q
    .select()
    .from(expense)
    .where(and(eq(expense.purchaseId, state.target.id), notDeleted(expense)));
  const [head] = await appendOrderEvidence(db, [
    {
      orderKey: state.fact.orderKey,
      emailId: state.fact.emailId,
      input: importWriterInput.parse({
        ledgerPartyId: state.fact.ledgerPartyId,
        vendorId: state.fact.vendorId,
        vendorAccountId: state.target.vendorAccountId,
        runId,
        source: {
          kind: state.fact.sourceKind,
          externalKey: state.fact.sourceExternalKey,
          checksum: state.fact.checksum,
        },
        extraction: state.fact.extraction,
        primaryDocumentImageId: state.fact.primaryDocumentImageId,
        screenshotImageId: state.fact.screenshotImageId,
        productResolutions: state.correspondence.flatMap((binding) => {
          const selected = current.find((row) => row.id === binding.expenseId);
          if (!selected)
            throw new Error("The accepted item correspondence changed");
          return selected.productId
            ? [
                {
                  kind: "existing",
                  lineIndex: binding.lineIndex,
                  productId: selected.productId,
                },
              ]
            : [];
        }),
      }),
    },
  ]);
  if (!head) throw new Error("The reviewed accepted source is missing");
  const key = orderEventKey(head);
  const scope = { kind: "purchaseEvent", key: state.scope };
  const decisions: import("~/server/kernel/api").DecisionInput[] = [
    {
      channel: "assignment",
      kind: "set",
      subject: key,
      field: "purchaseId",
      value: state.target.id,
      scopes: [scope],
    },
  ];
  for (const binding of state.correspondence) {
    const line = head.productBindings.find(
      (row) => row.lineIndex === binding.lineIndex,
    );
    const selected = current.find((row) => row.id === binding.expenseId);
    if (!line || !selected)
      throw new Error("The reviewed item correspondence is missing");
    const stableLine = line.stableLineId ?? String(binding.lineIndex);
    const requested = resolution.lines.find(
      (row) => row.lineIndex === binding.lineIndex,
    );
    if (requested?.newProduct && !selected.productId)
      throw new Error("The reviewed new Product was not bound");
    decisions.push(
      {
        channel: "assignment",
        kind: "set",
        subject: `purchaseEvent:${key}`,
        field: `line-record:${stableLine}`,
        value: selected.id,
        scopes: [scope],
      },
      {
        channel: "assignment",
        kind: "set",
        subject: `purchaseEvent:${key}`,
        field: `line:${stableLine}`,
        value: selected.productId
          ? { kind: "existing", productId: selected.productId }
          : { kind: "expense_only" },
        scopes: [scope],
      },
    );
  }
  await decide(db, actor, decisions);
  await settleOrderEvidence(db, [head]);
  const [bound] = await q
    .select({ purchaseId: acceptedOrders.purchaseId })
    .from(acceptedOrders)
    .where(eq(acceptedOrders.id, head.id));
  if (bound?.purchaseId !== state.target.id)
    throw new Error(
      "The accepted Product binding did not retain its Purchase identity",
    );
}

/** Product-only review may change Product fields, but no accepted money or settlement. */
async function acceptedMoneyFingerprint(
  db: Database,
  purchaseId: typeof purchase.$inferSelect.id,
) {
  const q = repositoryQueries(db);
  const [
    purchases,
    expenses,
    attributions,
    allocations,
    transactions,
    transfers,
  ] = await Promise.all([
    q
      .select()
      .from(purchase)
      .where(eq(purchase.id, purchaseId))
      .orderBy(purchase.id),
    q
      .select()
      .from(expense)
      .where(eq(expense.purchaseId, purchaseId))
      .orderBy(expense.id),
    q
      .select({ row: expenseAttribution })
      .from(expenseAttribution)
      .innerJoin(expense, eq(expense.id, expenseAttribution.expenseId))
      .where(eq(expense.purchaseId, purchaseId))
      .orderBy(expenseAttribution.id),
    q
      .select()
      .from(financialTransactionAllocation)
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId))
      .orderBy(financialTransactionAllocation.id),
    q
      .select({ row: financialTransaction })
      .from(financialTransaction)
      .innerJoin(
        financialTransactionAllocation,
        eq(
          financialTransactionAllocation.transactionId,
          financialTransaction.id,
        ),
      )
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId))
      .orderBy(financialTransaction.id),
    q
      .select({ row: ledgerTransfer })
      .from(ledgerTransfer)
      .innerJoin(
        financialTransaction,
        eq(financialTransaction.ledgerTransferId, ledgerTransfer.id),
      )
      .innerJoin(
        financialTransactionAllocation,
        eq(
          financialTransactionAllocation.transactionId,
          financialTransaction.id,
        ),
      )
      .where(eq(financialTransactionAllocation.purchaseId, purchaseId))
      .orderBy(ledgerTransfer.id),
  ]);
  const snapshot = jsonSnapshot.parse({
    purchases: purchases.map((row) => ({
      ...row,
      updatedAt: null,
      statedTotal: row.statedTotal?.toString() ?? null,
    })),
    expenses: expenses.map((row) => ({
      ...row,
      updatedAt: null,
      productId: null,
      productQuantity: null,
      cost: row.cost?.toString() ?? null,
    })),
    attributions,
    allocations: allocations.map((row) => ({
      ...row,
      amountMinor: row.amountMinor.toString(),
    })),
    transactions: transactions.map(({ row }) => ({
      ...row,
      amount: row.amount.toString(),
    })),
    transfers: transfers.map(({ row }) => ({
      ...row,
      amount: row.amount.toString(),
    })),
  });
  return sha256CanonicalJson(snapshot);
}

/** Persisted minor units are hashed as exact decimal strings, never JSON BigInts. */
function acceptedFingerprint(state: Awaited<ReturnType<typeof acceptedState>>) {
  return sha256CanonicalJson(
    jsonSnapshot.parse({
      ...state,
      target: {
        ...state.target,
        statedTotal: state.target.statedTotal?.toString() ?? null,
      },
      expenses: state.expenses.map((row) => ({
        ...row,
        cost: row.cost?.toString() ?? null,
      })),
    }),
  );
}

/** Product review reads the accepted extraction and current records, never a second prepared ledger. */
export async function prepareAcceptedSourceOrderReconciliation(
  db: Database,
  input: Extract<
    PrepareSourceOrderReconciliationInput,
    { sourceOrderId: string }
  >,
  actor: ActorContext,
) {
  return householdWrite(db, async (database) => {
    const state = await acceptedState(
      database,
      input.sourceOrderId,
      actor,
      input.resolution,
    );
    const completed = await completeAcceptedResolution(
      database,
      state,
      input.resolution,
    );
    const preparations = await validateAcceptedPreparation(
      database,
      state,
      completed.resolution,
    );
    const carried = state.expenses.some((row) => row.cost === null)
      ? await repositoryQueries(database)
          .select({ id: expense.id })
          .from(expense)
          .where(
            and(
              eq(expense.purchaseId, state.target.id),
              notDeleted(expense),
              unpricedForeignExpenseSql({
                id: outer(expense.id),
                purchaseId: outer(expense.purchaseId),
                lineKind: outer(expense.lineKind),
                cost: outer(expense.cost),
              }),
            ),
          )
      : [];
    const carriedIds = new Set(carried.map((row) => row.id));
    const total = state.expenses.some(
      (row) => row.cost === null && !carriedIds.has(row.id),
    )
      ? null
      : state.expenses.reduce((sum, row) => sum + (row.cost ?? 0n), 0n);
    return prepareSourceOrderReconciliationOut.options[1].parse({
      sourceOrderId: input.sourceOrderId,
      reviewedFingerprint: await acceptedFingerprint(state),
      resolution: {
        ...completed.resolution,
        lines: completed.resolution.lines.map((binding) => ({
          ...binding,
          ...(binding.newProduct && preparations.has(binding.lineIndex)
            ? {
                newProduct: {
                  ...binding.newProduct,
                  preparedFingerprint: preparations.get(binding.lineIndex),
                },
              }
            : {}),
        })),
      },
      source: {
        kind: state.canonicalSource.kind,
        externalKey: state.canonicalSource.externalKey,
        checksum: state.fact.checksum,
      },
      orderKey: state.fact.orderKey,
      accepted: {
        checksum: state.fact.checksum,
        extraction: state.fact.extraction,
      },
      proposed: {
        checksum: state.fact.checksum,
        extraction: state.fact.extraction,
      },
      spend: {
        before: total === null ? null : minorToMoney(total),
        after: total === null ? null : minorToMoney(total),
        delta: 0,
      },
      expenses: state.expenses.map((row) => ({
        id: row.shortcode,
        title: row.name,
        amount: row.cost === null ? null : minorToMoney(row.cost),
        productId: row.productId
          ? (completed.codes.get(row.productId) ?? null)
          : null,
      })),
      payments: state.fact.extraction.candidate?.payments ?? [],
      proposedPayments: [],
      ...(await acceptedSettlementPreview(database, state)),
      attributions: [],
    });
  });
}

/** A Product review exposes the existing settlement and rounded attribution it preserves. */
async function acceptedSettlementPreview(
  db: Database,
  state: Awaited<ReturnType<typeof acceptedState>>,
) {
  const q = repositoryQueries(db);
  const { loadExpenseAllocations } =
    await import("~/server/domains/household-contribution/repo/allocation");
  const original = await loadExpenseAllocations(db, {
    expenseIds: state.expenses.map((row) => row.id),
    includeFuture: true,
  });
  const partyIds = [
    ...new Set(
      original.flatMap((row) => (row.ledgerPartyId ? [row.ledgerPartyId] : [])),
    ),
  ];
  const parties = partyIds.length
    ? await q
        .select({ id: ledgerParty.id, shortcode: ledgerParty.shortcode })
        .from(ledgerParty)
        .where(
          and(
            notDeleted(ledgerParty),
            requested(
              partyIds.map((id) => ({ entity: "ledgerParty" as const, id })),
            ).match({ entity: "ledgerParty", id: sql`${ledgerParty.id}` }),
          ),
        )
    : [];
  const allocations = await q
    .select({
      amount: financialTransactionAllocation.amountMinor,
      transactionId: financialTransaction.shortcode,
      postedDate: financialTransaction.postedDate,
    })
    .from(financialTransactionAllocation)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, financialTransactionAllocation.transactionId),
    )
    .where(
      and(
        eq(financialTransactionAllocation.purchaseId, state.target.id),
        notDeleted(financialTransactionAllocation),
        notDeleted(financialTransaction),
      ),
    );
  return {
    allocationTotal: minorToMoney(
      allocations.reduce((sum, row) => sum + row.amount, 0n),
    ),
    allocations: allocations.map((row) => ({
      transactionId: parseShortcodeFor(
        "financialTransaction",
        row.transactionId,
      ),
      amount: minorToMoney(row.amount),
      postedDate: row.postedDate,
    })),
    originalAttributions: original.map((row) => {
      const party = row.ledgerPartyId
        ? parties.find((party) => party.id === row.ledgerPartyId)
        : null;
      if (row.ledgerPartyId && !party)
        throw new Error("Accepted attribution party is missing");
      return {
        expenseId: row.expenseShortcode,
        role: row.role,
        partyId: party
          ? parseShortcodeFor("ledgerParty", party.shortcode)
          : null,
        amount: minorToMoney(row.cents),
      };
    }),
  };
}

/** The existing line's Product override is a durable member decision; its money stays accepted. */
export async function commitAcceptedSourceOrderReconciliation(
  db: Database,
  raw: CommitAcceptedSourceOrderReconciliationInput,
  actor: ActorContext,
) {
  const input = commitAcceptedSourceOrderReconciliationInput.parse(raw);
  return householdWrite(db, async (database) => {
    const state = await acceptedState(
      database,
      input.sourceOrderId,
      actor,
      input.resolution,
      input.reviewedPreparation,
    );
    const { resolution } = await completeAcceptedResolution(
      database,
      state,
      input.resolution,
    );
    await validateAcceptedPreparation(
      database,
      state,
      resolution,
      input.reviewedPreparation,
    );
    const moneyBefore = await acceptedMoneyFingerprint(
      database,
      state.target.id,
    );
    const newProducts = await resolveAcceptedNewProducts(
      database,
      state,
      resolution,
      actor,
    );
    let changed =
      !!state.originalReview && !state.originalReview.previousObservationId;
    let retained = false;
    const retain = async () => {
      if (retained) return;
      await retainAcceptedCorrespondence(database, state, actor);
      retained = true;
    };
    for (const binding of input.resolution.lines) {
      const selected = state.expenses.find(
        (row) => row.shortcode === binding.expenseId,
      )!;
      if (binding.newProduct) {
        if (state.appliedNewProducts.includes(binding.lineIndex)) continue;
        const productId = newProducts.get(binding.lineIndex);
        if (!productId) throw new Error("The reviewed new Product is missing");
        await retain();
        await updatePurchaseEventWhere(
          database,
          "expense",
          {
            productId,
            productQuantity:
              selected.productQuantity ??
              state.fact.extraction.candidate?.lines[binding.lineIndex]
                ?.quantity ??
              (importLineWritePolicy(state.fact.extraction).unpriced
                ? null
                : 1),
          },
          eq(expense.id, selected.id),
          actor,
        );
        await withTransaction(database, (tx) =>
          logAuditEntry(tx, actor, {
            entityKind: "expense",
            entityId: selected.id,
            action: "update",
            changes: {
              acceptedSourceProduct: {
                from: null,
                to: {
                  sourceOrderId: input.sourceOrderId,
                  lineIndex: binding.lineIndex,
                  productId,
                },
              },
            },
          }),
        );
        changed = true;
      } else {
        const productId = binding.productId
          ? await resolveOrThrow(database, "product", binding.productId)
          : null;
        if (productId === selected.productId) continue;
        await retain();
        await updatePurchaseEventWhere(
          database,
          "expense",
          {
            productId,
            productQuantity: productId
              ? (selected.productQuantity ??
                state.fact.extraction.candidate?.lines[binding.lineIndex]
                  ?.quantity ??
                (importLineWritePolicy(state.fact.extraction).unpriced
                  ? null
                  : 1))
              : null,
          },
          eq(expense.id, selected.id),
          actor,
        );
        changed = true;
      }
    }
    if (changed) {
      await retain();
      await reconcileNow(database, [
        { kind: "purchaseEvent", key: state.scope },
      ]);
    }
    if (changed)
      await recordAcceptedProductReview(database, state, actor, resolution);
    if (state.originalReview && !state.originalReview.previousObservationId) {
      const review = state.originalReview;
      await repositoryQueries(database)
        .update(importSourceOrder)
        .set({
          acceptedObservationId: review.observationId,
          checksum: state.fact.checksum,
        })
        .where(eq(importSourceOrder.id, review.associationId));
      await withTransaction(database, (tx) =>
        logAuditEntry(tx, actor, {
          entityKind: "purchase",
          entityId: state.target.id,
          action: "update",
          changes: {
            reviewedOriginalPreparation: {
              from: {
                acceptedObservationId: review.previousObservationId,
                checksum: review.previousChecksum,
              },
              to: {
                sourceOrderId: input.sourceOrderId,
                ...review.preparation,
                acceptedObservationId: review.observationId,
              },
            },
          },
        }),
      );
    }
    if (
      (await acceptedMoneyFingerprint(database, state.target.id)) !==
      moneyBefore
    ) {
      throw new Error(
        "Accepted Product association must preserve money, item ownership and settlement",
      );
    }
    return commitAcceptedSourceOrderReconciliationOut.parse({
      purchaseId: parseShortcodeFor("purchase", state.target.shortcode),
      alreadyApplied: !changed,
    });
  });
}
