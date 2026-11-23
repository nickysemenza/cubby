import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import { moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { entityIdentity } from "~/server/db/entity-identity-schema";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { canonicalUuids, uuidArrayParam } from "~/server/db/helpers/query";
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
  merchantKey,
  orderPayments,
  purchasePayments,
  transactionAmounts,
  vendorMerchants,
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
  orderClaimPurchaseKey,
  orderEventKey,
  orderPaymentKeys,
  paymentAmountKey,
  retainedPaymentEvidence,
} from "~/server/domains/purchase-import/repo/order-evidence";
import {
  decisionKey,
  defineReadIndex,
  ownerKey,
  recordIdentity,
  effectiveBindings,
  recordSubject,
  source,
  type Binding,
  type Pure,
  type Reconciler,
  type ScopeReads,
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
  /** Each Order's payment set, in `payments` order. */
  paymentsByOrder: ReadonlyMap<string, Payment[]>;
  /** Live Vendor ids by normalized name or alias. */
  vendorsByMerchant: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each fact's effective binding, by fact kind and id. */
  effectiveBindings: ReadonlyMap<string, Binding>;
};

/** One payment scope's connected Orders and payments, followed through its own reads. */
type PaymentClosure = {
  key: string;
  scoped: ScopeReads;
  visited: Set<string>;
  pending: string[];
  orders: Order[];
  payments: Payment[];
};

const newerOrder = (candidate: Order, existing: Order) =>
  candidate.createdAt > existing.createdAt ||
  (candidate.createdAt.getTime() === existing.createdAt.getTime() &&
    candidate.id > existing.id);

/** One accepted head per original; later raw retrievals cannot change these facts. */
export function acceptedOrderHeads(orders: readonly Order[], c: Pure) {
  const heads = new Map<string, Order>();
  for (const row of orders) {
    const identity = `${orderEventKey(row)}\0${row.sourceKind}\0${row.sourceExternalKey || row.sourceClaimId}`;
    const current = heads.get(identity);
    if (!current || newerOrder(row, current)) heads.set(identity, row);
  }
  const selected = [...heads.values()];
  const byId = new Map(selected.map((row) => [row.id, row]));
  return selected.filter((row) => {
    const choice = c.decision(
      "assignment",
      orderEventKey(row),
      orderSourceHeadField(row),
    );
    if (choice?.kind !== "set") return true;
    const parsed = reviewedOrderHead.safeParse(choice.value);
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
  const amountScope = key.startsWith("payment:amount:");
  if (!amountScope) {
    for (const route of new Set([...amountKeys, ...retainedKeys]))
      c.emit({ kind: "purchaseEvent", key: route });
    if (
      amountKeys.length &&
      !heads.some((head) => provenOwners.get(head.id) === key)
    )
      return;
  }
  return {
    paymentKeys,
    amountKeys,
    publishesReview:
      amountScope || (amountKeys.length === 0 && retainedKeys.size === 0),
  };
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
  // A cross-scope merge leaves the absorbed scope's key pointing at the
  // survivor's id: the live owner wins, independent of row order.
  const owners = input.records.filter(
    (record) =>
      record.entity === "purchase" &&
      record.entityId === chosenId &&
      record.scopeKind === "purchaseEvent",
  );
  const live = owners.filter(
    (record) => !record.mergedAt && !record.rejectedAt,
  );
  return (live.length ? live : owners)
    .map((record) => record.scopeKey)
    .sort()[0];
}

const allocationTransaction = z.object({
  table: z.literal("FinancialTransactionAllocation"),
  values: z.object({ transactionId: z.string() }),
});
const allocationTransactionOf = (value: unknown) => {
  const parsed = allocationTransaction.safeParse(value);
  return parsed.success ? [parsed.data.values.transactionId] : [];
};
/**
 * Member allocations naming a transaction. Both tables are insert-only, so a
 * row never moves between memberships. Match
 * `ManualEntry_allocation_transaction_idx` and
 * `Decision_allocation_transaction_idx`.
 */
const manualAllocations = defineReadIndex(manualEntry, {
  name: "manualAllocation.transaction",
  values: (row) => allocationTransactionOf(row.payload),
  where: (values) =>
    sql`${manualEntry.payload}#>>'{table}' = 'FinancialTransactionAllocation'
      AND ${manualEntry.payload}->'values'->>'transactionId' = ANY(${textArrayParam(values)})`,
});
const decidedAllocations = defineReadIndex(decision, {
  name: "decisionAllocation.transaction",
  values: (row) =>
    row.channel === decisionChannel.enum.assignment
      ? allocationTransactionOf(row.value)
      : [],
  where: (values) =>
    sql`${decision.value}#>>'{table}' = 'FinancialTransactionAllocation'
      AND ${decision.channel} = ${decisionChannel.enum.assignment}
      AND ${decision.value}->'values'->>'transactionId' = ANY(${textArrayParam(values)})`,
});

const factIndexKey = (kind: string, id: string) => `${kind}\u0000${id}`;
const bindingFor = (input: PaymentMatchInput, kind: string, id: string) =>
  input.effectiveBindings.get(factIndexKey(kind, id));

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
        vendors:
          input.vendorsByMerchant.get(
            merchantKey(transaction.merchant ?? ""),
          ) ?? new Set<string>(),
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
    source.table(
      financialTransaction,
      [
        "accountId",
        "amount",
        "kind",
        "status",
        "transactionDate",
        "postedDate",
        "merchant",
        "deletedAt",
      ],
      [transactionAmounts],
    ),
    source.table(financialAccount, [
      "ledgerPartyId",
      "identity",
      "cardNumbers",
      "deletedAt",
    ]),
    source.table(vendor, ["name", "aliases", "deletedAt"], [vendorMerchants]),
    source.table(recordKey, ["scopeKind", "scopeKey", "entity", "entityId"]),
    source.table(entityIdentity, [
      "kind",
      "shortcode",
      "deletedAt",
      "mergedIntoId",
    ]),
    source.table(manualEntry, ["entity", "payload"], [manualAllocations]),
    source.table(
      decision,
      ["channel", "subject", "field", "kind", "value", "at"],
      [decidedAllocations],
    ),
  ],
  async load(reads, keys) {
    const unique = <T extends { id: string }>(rows: readonly T[]): T[] => [
      ...new Map(rows.map((row) => [row.id, row])).values(),
    ];
    // Each scope follows its own payment amounts to all contenders and
    // completes each source's payment set through its own scope, so a
    // batchmate's Order, charge or decision never wakes it. An exact-key read
    // also fences an empty matching set. Each phase issues every open scope's
    // reads in one tick: they coalesce into one statement per source.
    const closures = keys.map((key): PaymentClosure => ({
      key,
      scoped: reads.for(key),
      visited: new Set(),
      pending: [key],
      orders: [],
      payments: [],
    }));
    for (
      let open = closures;
      open.length;
      open = closures.filter((closure) => closure.pending.length)
    ) {
      for (const closure of open)
        for (const key of closure.pending) closure.visited.add(key);
      const found = await Promise.all(
        open.map((closure) =>
          Promise.all([
            closure.scoped.facts(orderEvidence, closure.pending),
            closure.scoped.lookup(
              purchasePaymentEvidence,
              amountPayments,
              closure.pending
                .map(paymentAmount)
                .filter((value) => value !== undefined),
            ),
          ]),
        ),
      );
      // Legacy payments may lead to an Order whose extraction omitted their
      // amount. Use both link shapes to find event keys, then read their facts.
      const legacy = found.map(([, byAmount]) =>
        byAmount.flatMap((row) =>
          !row.orderObservationId && row.sourceClaimId && row.purchaseId
            ? [{ claim: row.sourceClaimId, purchase: row.purchaseId }]
            : [],
        ),
      );
      const legacyLinks = requestedRows(
        legacy.flat(),
        { claim: "uuid", purchase: "uuid" },
        "payment_order_links",
      );
      const [directOrders, legacyOrders] = await Promise.all([
        Promise.all(
          open.map((closure, index) =>
            closure.scoped.rows(
              sourceOrderObservation,
              found[index]![1].flatMap((row) =>
                row.orderObservationId ? [row.orderObservationId] : [],
              ),
            ),
          ),
        ),
        reads.selectEach(
          sourceOrderObservation,
          new Map(
            open.map((closure, index) => [
              closure.key,
              legacy[index]!.map(({ claim, purchase }) =>
                orderClaimPurchaseKey(claim, purchase),
              ),
            ]),
          ),
          sql`EXISTS (
            SELECT 1 FROM ${legacyLinks.from}
            WHERE ${sourceOrderObservation.sourceClaimId} = ${legacyLinks.col("claim")}
              AND ${sourceOrderObservation.purchaseId} = ${legacyLinks.col("purchase")}
          )`,
        ),
      ]);
      const linked = open.map((closure, index) => {
        const own = new Set(
          legacy[index]!.map(({ claim, purchase }) =>
            orderClaimPurchaseKey(claim, purchase),
          ),
        );
        const latestLegacyOrders = new Map<string, Order>();
        for (const row of legacyOrders) {
          if (!row.sourceClaimId || !row.purchaseId) continue;
          const link = orderClaimPurchaseKey(row.sourceClaimId, row.purchaseId);
          if (!own.has(link)) continue;
          const current = latestLegacyOrders.get(link);
          if (!current || newerOrder(row, current))
            latestLegacyOrders.set(link, row);
        }
        closure.orders = unique([
          ...closure.orders,
          ...[...found[index]![0].values()].flat(),
        ]);
        return [
          ...directOrders[index]!.values(),
          ...latestLegacyOrders.values(),
        ];
      });
      const completed = await Promise.all(
        open.map((closure) =>
          Promise.all([
            closure.scoped.lookup(
              purchasePaymentEvidence,
              orderPayments,
              closure.orders.map((row) => row.id),
            ),
            closure.scoped.lookup(
              purchasePaymentEvidence,
              purchasePayments,
              closure.orders.flatMap((row) =>
                row.purchaseId ? [row.purchaseId] : [],
              ),
            ),
          ]),
        ),
      );
      open.forEach((closure, index) => {
        const [observed, retained] = completed[index]!;
        closure.payments = unique([
          ...closure.payments,
          ...observed,
          ...retained,
        ]);
        closure.pending = [
          ...new Set([
            ...linked[index]!.map(orderEventKey),
            ...closure.orders.flatMap((row) => [
              orderEventKey(row),
              ...orderPaymentKeys(row),
            ]),
            ...closure.payments.map((row) => paymentAmountKey(row.amountMinor)),
          ]),
        ].filter((key) => !closure.visited.has(key));
      });
    }
    // A scope's Orders name their charges and Purchases through in-force
    // decisions on their events and Emails. An identity `same` can select a
    // charge at an amount outside the closure; a `purchaseId` assignment
    // chooses the Purchase whose owner the proof follows.
    const subjectsOf = closures.map(
      (closure) =>
        new Set(
          closure.orders.flatMap((row) => [
            orderEventKey(row),
            ...(row.emailId ? [recordSubject("email", row.emailId)] : []),
          ]),
        ),
    );
    const eventsOf = closures.map(
      (closure) => new Set(closure.orders.map(orderEventKey)),
    );
    const allSubjects = [...new Set(subjectsOf.flatMap((set) => [...set]))];
    const allEvents = [...new Set(eventsOf.flatMap((set) => [...set]))];
    const choices = await reads.selectEach(
      decision,
      new Map(
        closures.map((closure, index) => [
          closure.key,
          [...subjectsOf[index]!].map(decisionKey),
        ]),
      ),
      sql`${decision.id} = ANY(ARRAY(
        SELECT DISTINCT ON (d.subject, d.channel, d.slot) d.id FROM "Decision" d
        WHERE (d.channel = ${decisionChannel.enum.assignment} AND d.slot = 'purchaseId'
            AND d.subject = ANY(${textArrayParam(allSubjects)}))
          OR (d.channel = ${decisionChannel.enum.identity}
            AND (d.subject = ANY(${textArrayParam(allEvents)}) OR d.other = ANY(${textArrayParam(allEvents)})))
        ORDER BY d.subject, d.channel, d.slot, d.at DESC, d.id DESC))`,
    );
    const transactionSubject = recordSubject("financialTransaction", "");
    const selectedOf = eventsOf.map((events) =>
      choices.flatMap((row) => {
        if (
          row.channel !== decisionChannel.enum.identity ||
          row.kind !== "same"
        )
          return [];
        const other = events.has(row.subject)
          ? row.other
          : row.other && events.has(row.other)
            ? row.subject
            : null;
        return other?.startsWith(transactionSubject)
          ? canonicalUuids([other.slice(transactionSubject.length)])
          : [];
      }),
    );
    const purchaseChoicesOf = subjectsOf.map((subjects) =>
      choices.flatMap((row) =>
        row.channel === decisionChannel.enum.assignment &&
        row.kind === "set" &&
        subjects.has(row.subject) &&
        typeof row.value === "string"
          ? [row.value]
          : [],
      ),
    );
    // `c.reference` reads an id in any letter case and a shortcode in upper case.
    const uuidLike =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    const choiceIdsOf = purchaseChoicesOf.map((values) =>
      values
        .filter((value) => uuidLike.test(value))
        .map((v) => v.toLowerCase()),
    );
    const choiceCodesOf = purchaseChoicesOf.map((values) =>
      values
        .filter((value) => !uuidLike.test(value))
        .map((v) => v.toUpperCase()),
    );
    const [transactionsOf, namedById, namedByCode] = await Promise.all([
      Promise.all(
        closures.map(async (closure, index) => {
          const [byAmount, selected] = await Promise.all([
            closure.scoped.lookup(financialTransaction, transactionAmounts, [
              ...new Set([
                ...closure.payments.map((row) => String(row.amountMinor)),
                ...[paymentAmount(closure.key)].filter(
                  (value) => value !== undefined,
                ),
              ]),
            ]),
            closure.scoped.rows(financialTransaction, selectedOf[index]!),
          ]);
          return unique([...byAmount, ...selected.values()]);
        }),
      ),
      Promise.all(
        closures.map((closure, index) =>
          closure.scoped.rows(entityIdentity, choiceIdsOf[index]!),
        ),
      ),
      // A shortcode never changes; the choice's decision key fences it.
      reads.selectEach(
        entityIdentity,
        new Map(
          closures.map((closure, index) => [
            closure.key,
            choiceCodesOf[index]!.length
              ? [...subjectsOf[index]!].map(decisionKey)
              : [],
          ]),
        ),
        sql`${entityIdentity.shortcode} = ANY(${textArrayParam(choiceCodesOf.flat())})`,
      ),
    ]);
    // Follow merge redirects to the survivor `c.reference` returns. Every id
    // on a chain is fenced by its owner key: a merge raises both records'.
    const chainsOf = closures.map((_, index) => {
      const codes = new Set(choiceCodesOf[index]);
      return [
        ...namedById[index]!.values(),
        ...namedByCode.filter(
          (row) => row.shortcode && codes.has(row.shortcode),
        ),
      ];
    });
    let pending = chainsOf.map((rows) => [...rows]);
    while (pending.some((rows) => rows.some((row) => row.mergedIntoId))) {
      const next = await Promise.all(
        closures.map((closure, index) => {
          const known = new Set(chainsOf[index]!.map((row) => row.id));
          return closure.scoped.rows(
            entityIdentity,
            pending[index]!.flatMap((row) =>
              row.mergedIntoId && !known.has(row.mergedIntoId)
                ? [row.mergedIntoId]
                : [],
            ),
          );
        }),
      );
      pending = next.map((rows) => [...rows.values()]);
      next.forEach((rows, index) => chainsOf[index]!.push(...rows.values()));
    }
    const purchasesOf = closures.map((closure, index) => {
      const byId = new Map(chainsOf[index]!.map((row) => [row.id, row]));
      const canonical = chainsOf[index]!.flatMap((start) => {
        let row: typeof start | undefined = start;
        const visited = new Set<string>();
        while (row?.mergedIntoId && !visited.has(row.id)) {
          visited.add(row.id);
          row = byId.get(row.mergedIntoId);
        }
        return row && row.kind === "purchase" && !row.deletedAt ? [row.id] : [];
      });
      return {
        owned: [
          ...new Set([
            ...closure.orders.flatMap((row) =>
              row.purchaseId ? [row.purchaseId] : [],
            ),
            ...canonical,
          ]),
        ],
        fenced: [...byId.keys()],
      };
    });
    const [scopedReads, owners] = await Promise.all([
      Promise.all(
        closures.map((closure, index) => {
          const transactions = transactionsOf[index]!;
          const ids = transactions.map((row) => row.id);
          return Promise.all([
            closure.scoped.rows(
              financialAccount,
              transactions.map((row) => row.accountId),
            ),
            closure.scoped.rows(
              vendor,
              closure.orders.flatMap((row) =>
                row.vendorId ? [row.vendorId] : [],
              ),
            ),
            // Merchant aliases participate in refusing a match at another Vendor.
            closure.scoped.lookup(vendor, vendorMerchants, [
              ...new Set(
                transactions
                  .map((row) => merchantKey(row.merchant ?? ""))
                  .filter(Boolean),
              ),
            ]),
            closure.scoped.lookup(manualEntry, manualAllocations, ids),
            closure.scoped.lookup(decision, decidedAllocations, ids),
            closure.scoped.bindings({
              facts: [
                ...closure.orders.map((row) => ({
                  kind: orderEvidence.kind,
                  id: row.id,
                })),
                ...closure.payments.map((row) => ({
                  kind: retainedPaymentEvidence.kind,
                  id: row.id,
                })),
              ],
              events: ids.map(paymentBankEventKey),
            }),
          ]);
        }),
      ),
      // Each scope fences the owners of the Purchases it can choose by their
      // owner keys, raised whenever a RecordKey naming them changes.
      reads.selectEach(
        recordKey,
        new Map(
          closures.map((closure, index) => {
            const { owned, fenced } = purchasesOf[index]!;
            return [
              closure.key,
              [...new Set([...owned, ...fenced])].map((id) =>
                ownerKey("purchase", id),
              ),
            ];
          }),
        ),
        sql`${recordKey.scopeKind} = 'purchaseEvent' AND ${recordKey.entity} = ${"purchase"}
          AND ${recordKey.entityId} = ANY(${uuidArrayParam(purchasesOf.flatMap((row) => row.owned))})`,
      ),
    ]);
    return new Map(
      closures.map(({ key, orders, payments }, index) => {
        const transactions = transactionsOf[index]!;
        const [accounts, orderVendors, merchants, manuals, recorded, bindings] =
          scopedReads[index]!;
        const owned = new Set(purchasesOf[index]!.owned);
        const records = owners.filter((row) => owned.has(row.entityId));
        const vendors = unique([...orderVendors.values(), ...merchants]);
        const totals = new Map(
          orders.map((row) => [
            row.id,
            row.extraction.candidate?.printedGrandTotal == null
              ? null
              : moneyToMinor(row.extraction.candidate.printedGrandTotal),
          ]),
        );
        // Every round of this scope's reconcile reads the same input: derive
        // the input-only indexes here rather than in each reconcile.
        const belongs = createOrderPaymentMatcher(orders, payments);
        const paymentsByOrder = new Map(
          orders.map((order) => [
            order.id,
            payments.filter((payment) => belongs(payment, order)),
          ]),
        );
        const vendorsByMerchant = new Map<string, Set<string>>();
        for (const row of vendors) {
          if (row.deletedAt) continue;
          for (const name of [row.name, ...row.aliases]) {
            const merchant = merchantKey(name);
            if (!merchant) continue;
            const ids = vendorsByMerchant.get(merchant) ?? new Set<string>();
            ids.add(row.id);
            vendorsByMerchant.set(merchant, ids);
          }
        }
        const effective = new Map(
          effectiveBindings(bindings).map((binding) => [
            factIndexKey(binding.fact.kind, binding.fact.id),
            binding,
          ]),
        );
        return [
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
            recordDecisions: recorded,
            bindings,
            totals,
            paymentsByOrder,
            vendorsByMerchant,
            effectiveBindings: effective,
          },
        ];
      }),
    );
  },

  reconcile(input, c) {
    const paymentsFor: PaymentsFor = (order) =>
      input.paymentsByOrder.get(order.id) ?? [];
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
      // The older Order proof owner can still plan without duplicating the
      // review published by the amount scopes it just emitted.
      const publishPaymentReview = (publish: () => void) => {
        if (routes.publishesReview) publish();
      };
      const plan = planFor(order);
      if (plan.kind === "conflicting") {
        publishPaymentReview(() =>
          c.gap.decision(
            "how the conflicting source payment evidence corresponds to recorded money",
          ),
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
        publishPaymentReview(() =>
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
          }),
        );
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
        publishPaymentReview(() =>
          c.gap.decision("which order owns this payment", {
            actions: (plan.matches ?? []).flatMap((match) => [
              {
                channel: "identity" as const,
                kind: "same" as const,
                subject: event,
                field: recordSubject(
                  "financialTransaction",
                  match.transactionId,
                ),
                label: "Same payment",
              },
              {
                channel: "identity" as const,
                kind: "distinct" as const,
                subject: event,
                field: recordSubject(
                  "financialTransaction",
                  match.transactionId,
                ),
                label: "Different payment",
              },
            ]),
          }),
        );
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
        // Disagreement holds existing output on this scope, including an older
        // Order proof. It is independent of which scope publishes review actions.
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
