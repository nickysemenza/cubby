import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import { statementMerchantKey } from "@cubby/schemas/statement-answers";
import { moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { textArrayParam } from "~/server/db/helpers/array-param";
import { requestedRows } from "~/server/db/helpers/requested";
import { decision, manualEntry, recordKey } from "~/server/db/kernel-schema";
import {
  financialAccount,
  financialTransaction,
  purchasePaymentEvidence,
  sourceOrderObservation,
  vendor,
} from "~/server/db/schema";
import { allocationSetViolation } from "~/server/domains/financial-transaction/policy/allocation-set";
import {
  amountPayments,
  orderPayments,
  purchasePayments,
} from "~/server/domains/financial-transaction/repo/money-read-indexes";
import { combinedChargeAllocations } from "~/server/domains/purchase-import/policy/combined-charge";
import {
  paymentBankEventKey,
  createOrderPaymentMatcher,
  reviewedOrderHead,
  orderSourceHeadField,
} from "~/server/domains/purchase-import/policy/payment-keys";
import {
  completePaymentMatches,
  type ChargeMatchRead,
} from "~/server/domains/purchase-import/policy/payment-match";
import {
  anchorPayments,
  normalizePaymentSet,
} from "~/server/domains/purchase-import/policy/retained-payments";
import {
  orderEvidence,
  orderEventKey,
  orderPaymentKeys,
  paymentAmountKey,
  retainedPaymentEvidence,
} from "~/server/domains/purchase-import/repo/order-evidence";
import {
  recordIdentity,
  effectiveBindings,
  recordSubject,
  source,
  type Binding,
  type Pure,
  type Reconciler,
} from "~/server/kernel/api";

type Order = typeof sourceOrderObservation.$inferSelect;
type Payment = typeof purchasePaymentEvidence.$inferSelect;
type Movement = typeof financialTransaction.$inferSelect;
export type PaymentMatchInput = {
  key: string;
  records: (typeof recordKey.$inferSelect)[];
  orders: Order[];
  payments: Payment[];
  transactions: Movement[];
  accounts: (typeof financialAccount.$inferSelect)[];
  vendors: (typeof vendor.$inferSelect)[];
  manuals: (typeof manualEntry.$inferSelect)[];
  recordDecisions: (typeof decision.$inferSelect)[];
  bindings: Binding[];
  totals: Map<string, bigint | null>;
};

/** One accepted head per original; later raw retrievals cannot change these facts. */
export function acceptedOrderHeads(orders: readonly Order[], c: Pure) {
  const heads = new Map<string, Order>();
  for (const row of orders) {
    const identity = `${orderEventKey(row)}\0${row.sourceKind}\0${row.sourceExternalKey || row.sourceClaimId}`;
    const current = heads.get(identity);
    if (
      !current ||
      current.createdAt < row.createdAt ||
      (current.createdAt.getTime() === row.createdAt.getTime() &&
        current.id < row.id)
    )
      heads.set(identity, row);
  }
  const selected = [...heads.values()];
  const byId = new Map(selected.map((row) => [row.id, row]));
  return selected.filter((row) => {
    const choice = c.decision(
      "assignment",
      orderEventKey(row),
      orderSourceHeadField(row),
    );
    const parsed = reviewedOrderHead.safeParse(
      choice?.kind === "set" ? choice.value : null,
    );
    if (!parsed.success || !parsed.data.supersedes.includes(row.id))
      return true;
    const replacement = byId.get(parsed.data.observationId);
    return (
      !replacement ||
      orderEventKey(replacement) !== orderEventKey(row) ||
      replacement.sourceKind !== row.sourceKind ||
      !(row.sourceClaimId
        ? replacement.sourceClaimId === row.sourceClaimId
        : replacement.sourceExternalKey === row.sourceExternalKey)
    );
  });
}

const paymentSetKey = (order: Order) =>
  `${orderEventKey(order)}:${order.extraction.candidate?.sourceEvent === "refunded" ? "refund" : "charge"}`;
type PaymentsFor = (order: Order) => Payment[];
const paymentAmount = (key: string) =>
  /^payment:amount:USD:(-?\d+)$/u.exec(key)?.[1];

function orderPaymentRoutes(
  heads: readonly Order[],
  bindings: readonly Binding[],
) {
  const keysByEvent = new Map<string, Set<string>>();
  for (const head of heads) {
    const event = orderEventKey(head);
    const keys = keysByEvent.get(event) ?? new Set<string>();
    for (const key of orderPaymentKeys(head)) keys.add(key);
    keysByEvent.set(event, keys);
  }
  const provenOwners = new Map(
    bindings
      .filter(
        (binding) =>
          binding.fact.kind === orderEvidence.kind &&
          binding.basis === "proven" &&
          binding.scope.kind === "purchaseEvent",
      )
      .map((binding) => [binding.fact.id, binding.scope.key]),
  );
  return { keysByEvent, provenOwners };
}

function planPaymentRoutes(
  key: string,
  heads: readonly Order[],
  paymentsFor: PaymentsFor,
  eventKeys: ReadonlySet<string> | undefined,
  provenOwners: ReadonlyMap<string, string>,
  c: Pure,
) {
  const retainedKeys = new Set(
    heads.flatMap((head) =>
      paymentsFor(head).map((row) => paymentAmountKey(row.amountMinor)),
    ),
  );
  if (!eventKeys?.has(key) && !retainedKeys.has(key)) return;
  const paymentKeys = [...new Set(heads.flatMap(orderPaymentKeys))].sort();
  const amountKeys = paymentKeys.filter((route) =>
    route.startsWith("payment:amount:"),
  );
  if (!key.startsWith("payment:amount:")) {
    for (const route of new Set([...amountKeys, ...retainedKeys]))
      c.emit({ kind: "purchaseEvent", key: route });
    if (
      amountKeys.length &&
      !heads.some((head) => provenOwners.get(head.id) === key)
    )
      return;
  }
  return { paymentKeys, amountKeys };
}

function orderBindingFallback(
  paymentKeys: readonly string[],
  amountKeys: readonly string[],
  retainedPayments: readonly { amountMinor: bigint }[],
) {
  const retainedAmount = retainedPayments[0]?.amountMinor;
  const retainedKey =
    retainedAmount === undefined ? undefined : paymentAmountKey(retainedAmount);
  return retainedKey && paymentKeys.includes(retainedKey)
    ? retainedKey
    : (amountKeys[0] ?? paymentKeys[0]);
}

function chosenOrderScope(input: PaymentMatchInput, order: Order, c: Pure) {
  const event = orderEventKey(order);
  const linked =
    c.decision("assignment", event, "purchaseId") ??
    (order.emailId
      ? c.decision("assignment", `email:${order.emailId}`, "purchaseId")
      : null);
  const chosenId =
    linked?.kind === "set" && typeof linked.value === "string"
      ? c.reference("purchase", linked.value)
      : order.purchaseId;
  const chosenScope = input.records.find(
    (record) =>
      record.entity === "purchase" &&
      record.entityId === chosenId &&
      record.scopeKind === "purchaseEvent",
  )?.scopeKey;
  return chosenScope;
}

const bindingFor = (input: PaymentMatchInput, kind: string, id: string) =>
  effectiveBindings(input.bindings).find(
    (binding) => binding.fact.kind === kind && binding.fact.id === id,
  );

const allocationInput = z.object({
  table: z.literal("FinancialTransactionAllocation"),
  values: z.object({
    transactionId: z.string(),
    purchaseId: z.string(),
    amountMinor: z
      .union([z.bigint(), z.string().regex(/^-?\d+$/u)])
      .transform((value) => BigInt(value)),
  }),
});
function allocationRows(input: PaymentMatchInput, c: Pure) {
  const values = [
    ...input.manuals.map((row) => row.payload),
    ...input.recordDecisions.flatMap((row) => {
      if (!row.field) return [];
      const current = c.decision("assignment", row.subject, row.field);
      return current?.kind === "set" ? [current.value] : [];
    }),
  ];
  const byTransaction = new Map<
    string,
    z.infer<typeof allocationInput>["values"][]
  >();
  for (const value of values) {
    const parsed = allocationInput.safeParse(value);
    if (!parsed.success) continue;
    const row = parsed.data.values;
    const rows = byTransaction.get(row.transactionId) ?? [];
    rows.push(row);
    byTransaction.set(row.transactionId, rows);
  }
  return byTransaction;
}

function paymentChoices(
  input: PaymentMatchInput,
  c: Pure,
  paymentsFor: PaymentsFor,
) {
  const merchant = (value: string | null) => statementMerchantKey(value ?? "");
  const knownVendor = (transaction: Movement) =>
    input.vendors.filter(
      (row) =>
        !row.deletedAt &&
        [row.name, ...row.aliases].some(
          (name) =>
            merchant(name) && merchant(name) === merchant(transaction.merchant),
        ),
    );
  const accounts = new Map(input.accounts.map((row) => [row.id, row]));
  const bindings = new Map<string, Binding[]>();
  for (const binding of input.bindings) {
    if (binding.fact.kind !== "retainedPayment") continue;
    const rows = bindings.get(binding.eventKey) ?? [];
    rows.push(binding);
    bindings.set(binding.eventKey, rows);
  }
  const movements = input.transactions.flatMap((transaction, position) => {
    const account = accounts.get(transaction.accountId);
    const date = transaction.transactionDate ?? transaction.postedDate;
    if (
      !account ||
      account.deletedAt ||
      transaction.deletedAt ||
      !date ||
      !["observed", "pending", "posted"].includes(transaction.status) ||
      !["purchase", "fee", "refund"].includes(transaction.kind) ||
      (transaction.kind === "refund"
        ? transaction.amount >= 0n
        : transaction.amount <= 0n)
    )
      return [];
    return [
      {
        transaction,
        position,
        party: account.ledgerPartyId,
        subject: recordSubject("financialTransaction", transaction.id),
        vendors: new Set(knownVendor(transaction).map((row) => row.id)),
        bindings: bindings.get(paymentBankEventKey(transaction.id)) ?? [],
        choice: {
          id: transaction.id,
          amountMinor: transaction.amount,
          occurredAt: new Date(`${date}T12:00:00.000Z`),
          cardLastFours: cardLastFoursOn(account.cardNumbers, date),
          storedValue: account.identity.kind === "stored_value",
        } satisfies ChargeMatchRead,
      },
    ];
  });
  const byAmount = new Map<bigint, typeof movements>();
  const bySubject = new Map<string, (typeof movements)[number]>();
  for (const movement of movements) {
    const amount = movement.transaction.amount;
    const roster = byAmount.get(amount) ?? [];
    roster.push(movement);
    byAmount.set(amount, roster);
    bySubject.set(movement.subject, movement);
  }
  let recordedRows: ReturnType<typeof allocationRows> | undefined;
  const allocations = new Map<
    string,
    { owners: Set<string>; invalid: boolean }
  >();
  return (order: Order, amounts?: ReadonlySet<bigint>) => {
    const event = orderEventKey(order);
    const decisions = c.identityDecisions(event);
    let roster = movements;
    if (amounts) {
      const selected = new Set(
        [...amounts].flatMap((amount) => byAmount.get(amount) ?? []),
      );
      // An explicit selection at another amount can suppress an automatic match.
      for (const [subject, choice] of decisions) {
        const movement = bySubject.get(subject);
        if (movement && choice === "same") selected.add(movement);
      }
      roster = [...selected].sort((a, b) => a.position - b.position);
    }
    const eligible: ChargeMatchRead[] = [];
    const explicit: ChargeMatchRead[] = [];
    let purchaseId: string | null | undefined;
    for (const movement of roster) {
      if (movement.party !== order.ledgerPartyId) continue;
      const { transaction } = movement;
      const decision = decisions.get(movement.subject);
      if (decision === "distinct") continue;
      if (
        decision !== "same" &&
        movement.vendors.size &&
        !movement.vendors.has(order.vendorId)
      )
        continue;
      // A member's recorded allocation is an accepted input, never spare capacity.
      let allocation = allocations.get(transaction.id);
      if (!allocation) {
        recordedRows ??= allocationRows(input, c);
        const byOwner = new Map<
          string,
          z.infer<typeof allocationInput>["values"]
        >();
        for (const row of recordedRows.get(transaction.id) ?? []) {
          const purchaseId = c.reference("purchase", row.purchaseId);
          if (purchaseId) byOwner.set(purchaseId, { ...row, purchaseId });
        }
        const recorded = [...byOwner.values()];
        allocation = {
          owners: new Set(recorded.map((row) => row.purchaseId)),
          invalid:
            recorded.length > 0 &&
            Boolean(
              allocationSetViolation({
                transactionAmountMinor: transaction.amount,
                kind: transaction.kind,
                next: recorded,
              }),
            ),
        };
        allocations.set(transaction.id, allocation);
      }
      if (purchaseId === undefined) {
        const target = c.decision("assignment", event, "purchaseId");
        purchaseId =
          target?.kind === "set" && typeof target.value === "string"
            ? (c.reference("purchase", target.value) ?? null)
            : order.purchaseId;
      }
      if (
        allocation.owners.size &&
        (!purchaseId ||
          !allocation.owners.has(purchaseId) ||
          allocation.invalid)
      )
        continue;
      const occupied = movement.bindings.some(
        (binding) =>
          !paymentsFor(order).some(
            (payment) => payment.id === binding.fact.id,
          ) &&
          !input.orders.some(
            (other) =>
              other.id !== order.id &&
              orderEventKey(other) === event &&
              paymentsFor(other).some(
                (payment) => payment.id === binding.fact.id,
              ),
          ),
      );
      if (occupied && decision !== "same") {
        const related = input.orders.some(
          (other) =>
            other.id !== order.id &&
            paymentsFor(other).some(
              (payment) =>
                bindingFor(input, "retainedPayment", payment.id)?.eventKey ===
                paymentBankEventKey(transaction.id),
            ) &&
            other.extraction.candidate?.payments.length === 1 &&
            order.extraction.candidate?.payments.length === 1,
        );
        if (!related) continue;
      }
      eligible.push(movement.choice);
      if (decision === "same") explicit.push(movement.choice);
    }
    return { eligible, explicit };
  };
}

function planOrder(
  input: PaymentMatchInput,
  order: Order,
  paymentsFor: PaymentsFor,
  heads: readonly Order[],
  choicesFor: ReturnType<typeof paymentChoices>,
) {
  const rows = heads.flatMap((row) => paymentsFor(row));
  const normalized = normalizePaymentSet(
    rows.map((row) => ({
      ...row,
      sourceClaimId: row.sourceClaimId ?? row.orderObservationId ?? row.id,
    })),
  );
  if (normalized === "conflicting_sources")
    return { kind: "conflicting" as const };
  const payments = anchorPayments(
    normalized,
    order.extraction.candidate?.orderedAt?.slice(0, 10) ?? null,
  );
  const total = input.totals.get(order.id);
  const paid = payments.reduce((sum, row) => sum + row.amountMinor, 0n);
  const abs = (value: bigint) => (value < 0n ? -value : value);
  const { eligible, explicit } = choicesFor(
    order,
    new Set(payments.map((payment) => payment.amountMinor)),
  );
  // An existing movement a member explicitly reviewed can remain a partial
  // settlement of a corrected total. New automatic matches still require the
  // complete order payment set and every ordinary movement eligibility check.
  const partial =
    total !== null && total !== undefined && abs(paid) < abs(total);
  const candidates = partial ? explicit : eligible;
  const matches = completePaymentMatches(
    payments,
    explicit.length ? explicit : candidates,
  );
  return {
    kind: "planned" as const,
    rows,
    payments,
    candidates,
    matches,
    partial,
  };
}

function contenderReview(input: PaymentMatchInput, c: Pure) {
  const selectedByTransaction = new Map<string, Order[]>();
  const combinedByTransaction = new Map<string, boolean>();
  return (
    transactionId: string,
    order: Order,
    contenders: readonly Order[],
  ) => {
    let selected = selectedByTransaction.get(transactionId);
    if (!selected) {
      selected = contenders.filter(
        (other) =>
          c.decision(
            "identity",
            orderEventKey(other),
            recordSubject("financialTransaction", transactionId),
          )?.kind === "same",
      );
      selectedByTransaction.set(transactionId, selected);
    }
    if (selected.length === 1 && selected[0]?.id === order.id) return false;
    let combined = combinedByTransaction.get(transactionId);
    if (combined === undefined) {
      const transaction = input.transactions.find(
        (row) => row.id === transactionId,
      )!;
      const members = contenders.map((other) => ({
        id: parseEntityId(
          "purchase",
          recordIdentity(
            { kind: "purchaseEvent", key: orderEventKey(other) },
            "Purchase",
            "purchase",
          ),
        ),
        statedTotalMinor: input.totals.get(other.id) ?? null,
        namesThisCharge: other.extraction.candidate?.payments.length === 1,
      }));
      combined = Boolean(
        combinedChargeAllocations({
          amountMinor: transaction.amount,
          memberIds: members.map((row) => row.id),
          hasAllocation: false,
          purchases: members,
        }),
      );
      combinedByTransaction.set(transactionId, combined);
    }
    return !combined;
  };
}

export const paymentMatching: Pick<
  Reconciler<PaymentMatchInput>,
  "reads" | "load" | "reconcile"
> = {
  reads: [
    source.evidence(orderEvidence),
    source.evidence(retainedPaymentEvidence),
    source.bindings,
    source.table(sourceOrderObservation, [
      "orderKey",
      "ledgerPartyId",
      "vendorId",
      "extraction",
      "sourceKind",
      "sourceExternalKey",
      "sourceClaimId",
      "purchaseId",
      "createdAt",
    ]),
    source.table(
      purchasePaymentEvidence,
      [
        "orderObservationId",
        "sourceClaimId",
        "purchaseId",
        "amountMinor",
        "chargedAt",
        "cardLastFour",
        "tender",
        "evidenceIndex",
      ],
      [amountPayments, orderPayments, purchasePayments],
    ),
    source.table(financialTransaction, [
      "accountId",
      "amount",
      "kind",
      "status",
      "transactionDate",
      "postedDate",
      "merchant",
      "deletedAt",
    ]),
    source.table(financialAccount, [
      "ledgerPartyId",
      "identity",
      "cardNumbers",
      "deletedAt",
    ]),
    source.table(vendor, ["name", "aliases", "deletedAt"]),
    source.table(recordKey, ["scopeKind", "scopeKey", "entity", "entityId"]),
    source.table(manualEntry, ["entity", "payload"]),
    source.table(decision, [
      "channel",
      "subject",
      "field",
      "kind",
      "value",
      "at",
    ]),
  ],
  async load(reads, keys) {
    const unique = <T extends { id: string }>(rows: readonly T[]): T[] => [
      ...new Map(rows.map((row) => [row.id, row])).values(),
    ];
    // Follow shared payment amounts to all contenders and complete each source's
    // payment set. An exact-key read also fences an empty matching set.
    const visited = new Set<string>();
    let pending = [...keys];
    let orders: Order[] = [];
    let payments: Payment[] = [];
    while (pending.length) {
      for (const key of pending) visited.add(key);
      const amounts = pending
        .map(paymentAmount)
        .filter((value) => value !== undefined);
      const [facts, byAmount] = await Promise.all([
        reads.facts(orderEvidence, pending),
        reads.lookup(purchasePaymentEvidence, amountPayments, amounts),
      ]);
      // Legacy payments may lead to an Order whose extraction omitted their
      // amount. Use both link shapes to find event keys, then read their facts.
      const legacy = byAmount.flatMap((row) =>
        !row.orderObservationId && row.sourceClaimId && row.purchaseId
          ? [{ claim: row.sourceClaimId, purchase: row.purchaseId }]
          : [],
      );
      const legacyLinks = requestedRows(
        legacy,
        { claim: "uuid", purchase: "uuid" },
        "payment_order_links",
      );
      const [directOrders, legacyOrders] = await Promise.all([
        reads.rows(
          sourceOrderObservation,
          byAmount.flatMap((row) =>
            row.orderObservationId ? [row.orderObservationId] : [],
          ),
        ),
        legacy.length
          ? reads.select(
              sourceOrderObservation,
              [],
              sql`EXISTS (
              SELECT 1 FROM ${legacyLinks.from}
              WHERE ${sourceOrderObservation.sourceClaimId} = ${legacyLinks.col("claim")}
                AND ${sourceOrderObservation.purchaseId} = ${legacyLinks.col("purchase")}
            )`,
            )
          : [],
      ]);
      orders = unique([...orders, ...[...facts.values()].flat()]);
      const [observed, retained] = await Promise.all([
        reads.lookup(
          purchasePaymentEvidence,
          orderPayments,
          orders.map((row) => row.id),
        ),
        reads.lookup(
          purchasePaymentEvidence,
          purchasePayments,
          orders.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])),
        ),
      ]);
      payments = unique([...payments, ...observed, ...retained]);
      pending = [
        ...new Set([
          ...[...directOrders.values(), ...legacyOrders].map(orderEventKey),
          ...orders.flatMap((row) => [
            orderEventKey(row),
            ...orderPaymentKeys(row),
          ]),
          ...payments.map((row) => paymentAmountKey(row.amountMinor)),
        ]),
      ].filter((key) => !visited.has(key));
    }
    const amounts = [
      ...new Set([
        ...payments.map((row) => String(row.amountMinor)),
        ...keys.map(paymentAmount).filter((value) => value !== undefined),
      ]),
    ];
    const transactions = await reads.select(
      financialTransaction,
      [],
      sql`${financialTransaction.amount} = ANY(${textArrayParam(amounts)}::bigint[])`,
    );
    const transactionIds = transactions.map((row) => row.id);
    const events = orders.map(orderEventKey);
    const [accounts, vendors, manuals, recordDecisions, records, bindings] =
      await Promise.all([
        reads.rows(
          financialAccount,
          transactions.map((row) => row.accountId),
        ),
        // Merchant aliases participate in refusing a match at another Vendor.
        // Keep the roster fence while fetching only matching merchant aliases.
        reads.select(
          vendor,
          [],
          sql`${vendor.id}::text = ANY(${textArrayParam(orders.map((row) => row.vendorId))})
        OR EXISTS (SELECT 1 FROM unnest(array_prepend(${vendor.name}, ${vendor.aliases})) alias
          WHERE lower(regexp_replace(regexp_replace(alias, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', ' ', 'g')) = ANY(
            ${textArrayParam(transactions.map((row) => statementMerchantKey(row.merchant ?? "")))}) )`,
        ),
        reads.select(
          manualEntry,
          [],
          sql`${manualEntry.payload}#>>'{table}' = 'FinancialTransactionAllocation'
        AND ${manualEntry.payload}->'values'->>'transactionId' = ANY(${textArrayParam(transactionIds)})`,
        ),
        reads.select(
          decision,
          [],
          sql`${decision.channel} = ${decisionChannel.enum.assignment}
        AND ${decision.value}#>>'{table}' = 'FinancialTransactionAllocation'
        AND ${decision.value}->'values'->>'transactionId' = ANY(${textArrayParam(transactionIds)})`,
        ),
        reads.select(
          recordKey,
          [],
          sql`${recordKey.scopeKind} = 'purchaseEvent' AND (
        ${recordKey.scopeKey} = ANY(${textArrayParam([...events, ...transactionIds])})
        OR ${recordKey.entityId}::text = ANY(${textArrayParam(orders.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])))})
        OR ${recordKey.entityId}::text IN (SELECT e.id::text FROM "Decision" choice JOIN "Entity" e
          ON (e.id = CASE WHEN pg_input_is_valid(choice.value #>> '{}', ${"uuid"})
            THEN (choice.value #>> '{}')::uuid END AND e.id::text = choice.value #>> '{}')
            OR e.shortcode = choice.value #>> '{}'
          WHERE choice.channel = ${decisionChannel.enum.assignment} AND choice.field = 'purchaseId'
            AND choice.subject = ANY(${textArrayParam([...events, ...orders.flatMap((row) => (row.emailId ? [`email:${row.emailId}`] : []))])}))
      )`,
        ),
        reads.bindings({
          facts: [
            ...orders.map((row) => ({ kind: orderEvidence.kind, id: row.id })),
            ...payments.map((row) => ({
              kind: retainedPaymentEvidence.kind,
              id: row.id,
            })),
          ],
          events: transactions.map((row) => paymentBankEventKey(row.id)),
        }),
      ]);
    const totals = new Map(
      orders.map((row) => [
        row.id,
        row.extraction.candidate?.printedGrandTotal == null
          ? null
          : moneyToMinor(row.extraction.candidate.printedGrandTotal),
      ]),
    );
    return new Map(
      keys.map((key) => [
        key,
        {
          key,
          orders,
          records,
          payments,
          transactions,
          accounts: [...accounts.values()],
          vendors,
          manuals,
          recordDecisions,
          bindings,
          totals,
        },
      ]),
    );
  },
  reconcile(input, c) {
    const belongs = createOrderPaymentMatcher(input.orders, input.payments);
    const paymentsByOrder = new Map<string, Payment[]>();
    const paymentsFor: PaymentsFor = (order) => {
      const existing = paymentsByOrder.get(order.id);
      if (existing) return existing;
      const payments = input.payments.filter((payment) =>
        belongs(payment, order),
      );
      paymentsByOrder.set(order.id, payments);
      return payments;
    };
    const heads = acceptedOrderHeads(input.orders, c);
    const headsByPaymentSet = new Map<string, Order[]>();
    const events = new Map<string, Order>();
    const { keysByEvent, provenOwners } = orderPaymentRoutes(
      heads,
      input.bindings,
    );
    for (const head of heads) {
      const key = paymentSetKey(head);
      const group = headsByPaymentSet.get(key) ?? [];
      group.push(head);
      headsByPaymentSet.set(key, group);
      events.set(key, head);
    }
    // Decisions and references are fixed within this scope's reconcile round.
    // Reuse plans only within that round so later evidence still re-plans.
    const choicesFor = paymentChoices(input, c, paymentsFor);
    const plans = new Map<string, ReturnType<typeof planOrder>>();
    const planFor = (order: Order) => {
      const existing = plans.get(order.id);
      if (existing) return existing;
      const plan = planOrder(
        input,
        order,
        paymentsFor,
        headsByPaymentSet.get(paymentSetKey(order)) ?? [],
        choicesFor,
      );
      plans.set(order.id, plan);
      return plan;
    };
    let contendersByTransaction: Map<string, Order[]> | undefined;
    const contendersFor = (transactionId: string) => {
      if (!contendersByTransaction) {
        contendersByTransaction = new Map();
        for (const order of events.values()) {
          const plan = planFor(order);
          if (plan.kind !== "planned") continue;
          for (const id of new Set(
            plan.matches?.map((match) => match.transactionId),
          )) {
            const contenders = contendersByTransaction.get(id) ?? [];
            contenders.push(order);
            contendersByTransaction.set(id, contenders);
          }
        }
      }
      return contendersByTransaction.get(transactionId) ?? [];
    };
    const requiresContenderReview = contenderReview(input, c);
    for (const order of events.values()) {
      const event = orderEventKey(order);
      const eventKeys = keysByEvent.get(event);
      const paymentHeads = headsByPaymentSet.get(paymentSetKey(order)) ?? [];
      const routes = planPaymentRoutes(
        input.key,
        paymentHeads,
        paymentsFor,
        eventKeys,
        provenOwners,
        c,
      );
      if (!routes) continue;
      const plan = planFor(order);
      if (plan.kind === "conflicting") {
        c.gap.decision(
          "how the conflicting source payment evidence corresponds to recorded money",
        );
        continue;
      }
      const ambiguous =
        plan.payments.length &&
        !plan.matches &&
        plan.candidates.some((candidate) =>
          plan.payments.some(
            (payment) => payment.amountMinor === candidate.amountMinor,
          ),
        );
      if (ambiguous) {
        c.gap.decision("which bank charge pays this order", {
          actions: (plan.partial
            ? plan.candidates
            : choicesFor(order).eligible
          ).flatMap((candidate) => [
            {
              channel: "identity" as const,
              kind: "same" as const,
              subject: event,
              field: recordSubject("financialTransaction", candidate.id),
              label: "Same payment",
            },
            {
              channel: "identity" as const,
              kind: "distinct" as const,
              subject: event,
              field: recordSubject("financialTransaction", candidate.id),
              label: "Different payment",
            },
          ]),
        });
        continue;
      }
      let competing = false;
      for (const match of plan.matches ?? []) {
        const contenders = contendersFor(match.transactionId);
        if (contenders.length <= 1) {
          const total = input.totals.get(order.id);
          if (
            plan.payments.length === 1 &&
            total !== null &&
            total !== undefined &&
            total !== match.amountMinor &&
            c.decision(
              "identity",
              event,
              recordSubject("financialTransaction", match.transactionId),
            )?.kind !== "same"
          )
            competing = true;
          continue;
        }
        if (requiresContenderReview(match.transactionId, order, contenders))
          competing = true;
      }
      if (competing) {
        c.gap.decision("which order owns this payment", {
          actions: (plan.matches ?? []).flatMap((match) => [
            {
              channel: "identity" as const,
              kind: "same" as const,
              subject: event,
              field: recordSubject("financialTransaction", match.transactionId),
              label: "Same payment",
            },
            {
              channel: "identity" as const,
              kind: "distinct" as const,
              subject: event,
              field: recordSubject("financialTransaction", match.transactionId),
              label: "Different payment",
            },
          ]),
        });
        continue;
      }
      const accepted =
        bindingFor(input, orderEvidence.kind, order.id) ??
        input.orders
          .filter((row) => orderEventKey(row) === event)
          .map((row) => bindingFor(input, orderEvidence.kind, row.id))
          .find((row) => row !== undefined);
      const existingBankEvent = (plan.matches ?? []).find((match) =>
        c.reference(
          "purchase",
          recordIdentity(
            { kind: "purchaseEvent", key: match.transactionId },
            "Purchase",
            "purchase",
          ),
        ),
      );
      const firstOrderForBank =
        existingBankEvent &&
        contendersFor(existingBankEvent.transactionId)
          .map(orderEventKey)
          .sort()[0] === event;
      const chosenScope = chosenOrderScope(input, order, c);
      const resolvedEvent =
        chosenScope ??
        accepted?.eventKey ??
        (firstOrderForBank ? existingBankEvent?.transactionId : null) ??
        event;
      const resolvedScope =
        accepted?.basis === "baseline" &&
        accepted.scope.kind === "purchaseEvent"
          ? accepted.scope.key
          : resolvedEvent;
      const changedBaseline = plan.rows.some((payment) => {
        const baseline = bindingFor(
          input,
          retainedPaymentEvidence.kind,
          payment.id,
        );
        if (baseline?.basis !== "baseline") return false;
        const match = plan.matches?.find(
          (row) => row.paymentIndex === payment.evidenceIndex,
        );
        return (
          (match ? paymentBankEventKey(match.transactionId) : null) !==
            baseline.eventKey &&
          c.decision(
            "identity",
            event,
            recordSubject(
              "financialTransaction",
              match?.transactionId ?? baseline.eventKey.replace(/^bank:/u, ""),
            ),
          )?.kind !== "same"
        );
      });
      if (changedBaseline) {
        c.disagree(
          "the accepted baseline payment binding disagrees with the current movement",
        );
        continue;
      }
      // An Order observation has one binding per basis. Extracted amounts can
      // route a legacy observation even when it has no retained payment rows.
      const fallbackOwner = orderBindingFallback(
        routes.paymentKeys,
        routes.amountKeys,
        plan.payments,
      );
      for (const head of paymentHeads) {
        const existingOwner = provenOwners.get(head.id);
        const owner = eventKeys?.has(existingOwner ?? "")
          ? existingOwner
          : fallbackOwner;
        if (input.key === owner)
          c.bind(
            { kind: orderEvidence.kind, id: head.id },
            resolvedEvent,
            "proven",
          );
      }
      for (const match of plan.matches ?? []) {
        const payment = plan.rows.find(
          (row) =>
            row.evidenceIndex === match.paymentIndex &&
            paymentAmountKey(row.amountMinor) === input.key,
        );
        if (!payment) continue;
        const decision = c.decision(
          "identity",
          event,
          recordSubject("financialTransaction", match.transactionId),
        );
        c.bind(
          { kind: retainedPaymentEvidence.kind, id: payment.id },
          paymentBankEventKey(match.transactionId),
          decision?.kind === "same" ? "decision" : "proven",
        );
      }
      c.emit(
        { kind: "purchaseEvent", key: resolvedScope },
        { when: "changed" },
      );
    }
    return c.done();
  },
};
