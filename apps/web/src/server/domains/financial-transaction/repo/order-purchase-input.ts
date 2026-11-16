import { entitySchema } from "@cubby/schemas/entity";
import { sql } from "drizzle-orm";

import { textArrayParam } from "~/server/db/helpers/array-param";
import { decision } from "~/server/db/kernel-schema";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
  purchase,
  purchasePaymentEvidence,
  sourceOrderObservation,
  spendingCategory,
  vendor,
  email,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import type { Input } from "~/server/domains/financial-transaction/repo/purchase-event-input";
import { orderBookingInput } from "~/server/domains/purchase-import/policy/order-booking";
import { orderEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
import { paymentBankEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
import { recordedAttributionMargins } from "~/server/domains/purchase-import/policy/replacement-attributions";
import { acceptedOrders } from "~/server/domains/purchase-import/repo/accepted-order-read";
import { parseMailSourceKey } from "~/server/domains/purchase-import/repo/import-scope";
import { orderEvidence } from "~/server/domains/purchase-import/repo/order-evidence";
import { unpricedForeignExpenseSql } from "~/server/domains/purchase-import/repo/writer-policy";
import type { ScopeReads } from "~/server/kernel/api";
import { decisionKey, rowKey } from "~/server/kernel/keys";

import {
  expenseAttributions,
  orderPayments,
  purchaseAllocations,
  purchaseExpenses,
  unlinkedProductExpenses,
  purchasePayments,
} from "./money-read-indexes";

type BankInput = Omit<
  Input,
  "orders" | "orderBindings" | "lumpAttributions" | "carriedExpenseIds"
>;
const unique = <T extends { id: string }>(rows: readonly T[]): T[] => [
  ...new Map(rows.map((row) => [row.id, row])).values(),
];

/** Read the same source-backed pricing exemption used by booking preview. */
async function carriedExpenseIds(
  reads: ScopeReads,
  expenses: Input["expenses"],
) {
  const pending = expenses.filter(
    (row) => !row.deletedAt && row.cost === null && row.purchaseId,
  );
  if (!pending.length) return [];
  const purchaseIds = [...new Set(pending.map((row) => row.purchaseId!))];
  // Ownership and roster revisions precede the derived provenance read. A
  // binding move to this Purchase raises its record key, even if its fields stay equal.
  const owners = await reads.select(
    recordKey,
    purchaseIds.map((id) => `record:purchase:${id}`),
    sql`${recordKey.entity}=${sqlEnumConstant(entitySchema, entitySchema.enum.purchase)} AND ${recordKey.scopeKind}='purchaseEvent'
      AND ${recordKey.entityId}=ANY(${textArrayParam(purchaseIds)}::uuid[])`,
  );
  const sources = await reads.prepare(
    [sourceOrderObservation],
    async (database) =>
      repositoryQueries(database)
        .select()
        .from(acceptedOrders)
        .where(
          sql`${acceptedOrders.purchaseId}=ANY(${textArrayParam(purchaseIds)}::uuid[])`,
        ),
  );
  await reads.bindings({
    facts: sources.map((row) => ({ kind: "orderObservation", id: row.id })),
  });
  const subjects = [
    ...new Set(
      [
        ...owners.map((row) => row.scopeKey),
        ...sources.map((row) => orderEventKey(row)),
      ].map((key) => `purchaseEvent:${key}`),
    ),
  ];
  await reads.select(
    decision,
    subjects.map(decisionKey),
    sql`${decision.subject}=ANY(${textArrayParam(subjects)})`,
  );
  return (
    await reads.select(
      expense,
      expenses.map((row) => rowKey("Expense", row.id)),
      sql`${expense.id}=ANY(${textArrayParam(pending.map((row) => row.id))}::uuid[])
      AND ${unpricedForeignExpenseSql({
        id: sql`${expense.id}`,
        purchaseId: sql`${expense.purchaseId}`,
        lineKind: sql`${expense.lineKind}`,
        cost: sql`${expense.cost}`,
      })}`,
    )
  ).map((row) => row.id);
}

/** Follow only this event's accepted facts, bindings and stored money graph. */
export async function loadOrderPurchaseInput(
  reads: ScopeReads,
  input: BankInput,
  productReferences: readonly string[],
): Promise<Input> {
  const eventBindings = await reads.bindings({
    events: [input.key, paymentBankEventKey(input.key)],
  });
  const [facts, boundOrders, boundPayments] = await Promise.all([
    reads.facts(orderEvidence, [input.key]),
    reads.rows(
      sourceOrderObservation,
      eventBindings.flatMap((row) =>
        row.fact.kind === "orderObservation" ? [row.fact.id] : [],
      ),
    ),
    reads.rows(
      purchasePaymentEvidence,
      eventBindings.flatMap((row) =>
        row.fact.kind === "retainedPayment" ? [row.fact.id] : [],
      ),
    ),
  ]);
  const paymentOrders = await reads.rows(
    sourceOrderObservation,
    [...boundPayments.values()].flatMap((row) =>
      row.orderObservationId ? [row.orderObservationId] : [],
    ),
  );
  const observations = unique([
    ...(facts.get(input.key) ?? []),
    ...boundOrders.values(),
    ...paymentOrders.values(),
  ]);
  if (!observations.length)
    return {
      ...input,
      carriedExpenseIds: await carriedExpenseIds(reads, input.expenses),
      orders: [],
      orderBindings: [],
      lumpAttributions: recordedAttributionMargins({
        expenses: input.expenses.filter(
          (row) => row.lineBasis === "allocation",
        ),
        attributions: input.attributions,
        parties: input.parties,
      }),
    };
  const [observedPayments, priorOrderPayments] = await Promise.all([
    reads.lookup(
      purchasePaymentEvidence,
      orderPayments,
      observations.map((row) => row.id),
    ),
    reads.lookup(
      purchasePaymentEvidence,
      purchasePayments,
      observations.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])),
    ),
  ]);
  const payments = unique([
    ...input.payments,
    ...boundPayments.values(),
    ...observedPayments,
    ...priorOrderPayments,
  ]);
  const orderBindings = await reads.bindings({
    facts: [
      ...observations.map((row) => ({ kind: orderEvidence.kind, id: row.id })),
      ...payments.map((row) => ({ kind: "retainedPayment", id: row.id })),
    ],
  });
  const bankIds = [
    ...new Set(
      orderBindings.flatMap((row) =>
        row.eventKey.startsWith("bank:") ? [row.eventKey.slice(5)] : [],
      ),
    ),
  ];
  // Own RecordKeys are serialized by the scope claim; other money rows retain
  // their ordinary row and index revision fences below.
  const owners = await reads.select(
    recordKey,
    [],
    sql`
    ${recordKey.scopeKind} = 'purchaseEvent'
    AND ${recordKey.scopeKey} = ANY(${textArrayParam([input.key, ...bankIds])})
  `,
  );
  const purchaseIds = [
    ...new Set([
      ...input.purchases.map((row) => row.id),
      ...observations.flatMap((row) =>
        row.purchaseId ? [row.purchaseId] : [],
      ),
      ...owners.flatMap((row) =>
        row.entity === "purchase" ? [row.entityId] : [],
      ),
    ]),
  ];
  const [
    purchases,
    expenses,
    allocations,
    legacyPayments,
    unlinkedExpenses,
    sourceMail,
  ] = await Promise.all([
    reads.rows(purchase, purchaseIds),
    reads.lookup(expense, purchaseExpenses, purchaseIds),
    reads.lookup(
      financialTransactionAllocation,
      purchaseAllocations,
      purchaseIds,
    ),
    reads.lookup(purchasePaymentEvidence, purchasePayments, purchaseIds),
    reads.lookup(expense, unlinkedProductExpenses, [
      ...new Set([
        ...productReferences,
        ...observations.flatMap((row) =>
          row.productBindings.flatMap((binding) =>
            binding.productId ? [binding.productId] : [],
          ),
        ),
      ]),
    ]),
    reads.rows(
      email,
      observations.flatMap((row) =>
        row.emailId &&
        !row.extraction.candidate?.orderedAt &&
        (row.extraction.candidate?.sourceEvent ?? "confirmation") ===
          "confirmation"
          ? [row.emailId]
          : [],
      ),
    ),
  ]);
  const allPurchases = unique([...input.purchases, ...purchases.values()]);
  const allExpenses = unique([
    ...input.expenses,
    ...expenses,
    ...unlinkedExpenses,
  ]);
  const allAllocations = unique([...input.allocations, ...allocations]);
  const [transactions, attributions] = await Promise.all([
    reads.rows(financialTransaction, [
      ...new Set([
        ...bankIds,
        ...allAllocations.map((row) => row.transactionId),
      ]),
    ]),
    reads.lookup(
      expenseAttribution,
      expenseAttributions,
      allExpenses.map((row) => row.id),
    ),
  ]);
  const allTransactions = unique([
    ...input.transactions,
    ...transactions.values(),
  ]);
  const [accounts, vendors, categories] = await Promise.all([
    reads.rows(financialAccount, [
      ...new Set(allTransactions.map((row) => row.accountId)),
    ]),
    reads.rows(vendor, [
      ...new Set([
        ...observations.map((row) => row.vendorId),
        ...allPurchases.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
      ]),
    ]),
    reads.rows(spendingCategory, [
      ...new Set([
        ...allPurchases.flatMap((row) =>
          row.spendingCategoryId ? [row.spendingCategoryId] : [],
        ),
        ...allExpenses.flatMap((row) =>
          row.spendingCategoryId ? [row.spendingCategoryId] : [],
        ),
      ]),
    ]),
  ]);
  const parties = await reads.rows(ledgerParty, [
    ...new Set(
      [...accounts.values()].flatMap((row) =>
        row.ledgerPartyId ? [row.ledgerPartyId] : [],
      ),
    ),
  ]);
  const allParties = unique([...input.parties, ...parties.values()]);
  const allAttributions = unique([...input.attributions, ...attributions]);
  return {
    ...input,
    orders: observations.map((observation) => {
      const binding = orderBindings.find(
        (row) =>
          row.fact.kind === "orderObservation" &&
          row.fact.id === observation.id,
      );
      const event =
        binding?.basis === "baseline" && binding.scope.kind === "purchaseEvent"
          ? binding.scope.key
          : binding?.eventKey;
      const scope = event?.startsWith("bank:")
        ? event.slice(5)
        : (event ?? input.key);
      const owner = owners.find(
        (row) =>
          row.entity === "purchase" &&
          row.scopeKey === scope &&
          !row.mergedAt &&
          !row.rejectedAt,
      );
      const targetId = owner?.entityId ?? observation.purchaseId;
      const target = allPurchases.find(
        (row) => row.id === targetId && !row.deletedAt,
      );
      const source = parseMailSourceKey(observation.sourceExternalKey);
      const original = [...sourceMail.values()].find(
        (row) =>
          row.id === observation.emailId &&
          row.mailboxId === source.mailboxId &&
          row.messageId === source.messageId,
      );
      return orderBookingInput(observation, {
        purchaseDate: target?.date ?? null,
        receivedAt: original?.receivedAt ?? null,
      });
    }),
    orderBindings,
    lumpAttributions: recordedAttributionMargins({
      expenses: allExpenses.filter((row) => row.lineBasis === "allocation"),
      attributions: allAttributions,
      parties: allParties,
    }),
    transactions: allTransactions,
    accounts: unique([...input.accounts, ...accounts.values()]),
    parties: allParties,
    purchases: allPurchases,
    expenses: allExpenses,
    carriedExpenseIds: await carriedExpenseIds(reads, allExpenses),
    allocations: allAllocations,
    attributions: allAttributions,
    vendors: unique([...input.vendors, ...vendors.values()]),
    categories: unique([...input.categories, ...categories.values()]),
    payments: unique([...payments, ...legacyPayments]),
  };
}
