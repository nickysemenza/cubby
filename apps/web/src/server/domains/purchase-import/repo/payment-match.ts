import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import { statementMerchantKey } from "@cubby/schemas/statement-answers";
import { moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { textArrayParam } from "~/server/db/helpers/array-param";
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
function recordedAllocations(
  input: PaymentMatchInput,
  c: Pure,
  transactionId: string,
) {
  const values = [
    ...input.manuals.map((row) => row.payload),
    ...input.recordDecisions.flatMap((row) => {
      if (!row.field) return [];
      const current = c.decision("assignment", row.subject, row.field);
      return current?.kind === "set" ? [current.value] : [];
    }),
  ];
  const rows = new Map<string, z.infer<typeof allocationInput>["values"]>();
  for (const value of values) {
    const parsed = allocationInput.safeParse(value);
    if (parsed.success && parsed.data.values.transactionId === transactionId) {
      const purchaseId = c.reference("purchase", parsed.data.values.purchaseId);
      if (purchaseId)
        rows.set(purchaseId, { ...parsed.data.values, purchaseId });
    }
  }
  return [...rows.values()];
}

function choices(
  input: PaymentMatchInput,
  order: Order,
  c: Pure,
  paymentsFor: PaymentsFor,
): ChargeMatchRead[] {
  const event = orderEventKey(order);
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
  return input.transactions.flatMap((transaction) => {
    const account = input.accounts.find(
      (row) => row.id === transaction.accountId,
    );
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
        : transaction.amount <= 0n) ||
      account.ledgerPartyId !== order.ledgerPartyId
    )
      return [];
    const decision = c.decision(
      "identity",
      event,
      recordSubject("financialTransaction", transaction.id),
    );
    if (decision?.kind === "distinct") return [];
    const known = knownVendor(transaction);
    if (
      decision?.kind !== "same" &&
      known.length &&
      !known.some((row) => row.id === order.vendorId)
    )
      return [];
    // A member's recorded allocation is an accepted input, never spare capacity.
    const recorded = recordedAllocations(input, c, transaction.id);
    const target = c.decision("assignment", event, "purchaseId");
    const purchaseId =
      target?.kind === "set" && typeof target.value === "string"
        ? c.reference("purchase", target.value)
        : order.purchaseId;
    if (
      recorded.length &&
      (!purchaseId ||
        !recorded.some((row) => row.purchaseId === purchaseId) ||
        allocationSetViolation({
          transactionAmountMinor: transaction.amount,
          kind: transaction.kind,
          next: recorded,
        }))
    )
      return [];
    const occupied = input.bindings.some(
      (binding) =>
        binding.fact.kind === "retainedPayment" &&
        binding.eventKey === paymentBankEventKey(transaction.id) &&
        !paymentsFor(order).some((payment) => payment.id === binding.fact.id) &&
        !input.orders.some(
          (other) =>
            other.id !== order.id &&
            orderEventKey(other) === event &&
            paymentsFor(other).some(
              (payment) => payment.id === binding.fact.id,
            ),
        ),
    );
    if (occupied && decision?.kind !== "same") {
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
      if (!related) return [];
    }
    return [
      {
        id: transaction.id,
        amountMinor: transaction.amount,
        occurredAt: new Date(`${date}T12:00:00.000Z`),
        cardLastFours: cardLastFoursOn(account.cardNumbers, date),
        storedValue: account.identity.kind === "stored_value",
      },
    ];
  });
}

function planOrder(
  input: PaymentMatchInput,
  order: Order,
  c: Pure,
  paymentsFor: PaymentsFor,
) {
  const sameEvent = acceptedOrderHeads(input.orders, c).filter(
    (row) => paymentSetKey(row) === paymentSetKey(order),
  );
  const rows = sameEvent.flatMap((row) => paymentsFor(row));
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
  const eligible = choices(input, order, c, paymentsFor);
  const explicit = eligible.filter(
    (candidate) =>
      c.decision(
        "identity",
        orderEventKey(order),
        recordSubject("financialTransaction", candidate.id),
      )?.kind === "same",
  );
  // An existing movement a member explicitly reviewed can remain a partial
  // settlement of a corrected total. New automatic matches still require the
  // complete order payment set and every ordinary movement eligibility check.
  const candidates =
    total !== null && total !== undefined && abs(paid) < abs(total)
      ? explicit
      : eligible;
  const matches = completePaymentMatches(
    payments,
    explicit.length ? explicit : candidates,
  );
  return { kind: "planned" as const, rows, payments, candidates, matches };
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
      const facts = await reads.facts(orderEvidence, pending);
      orders = unique([...orders, ...[...facts.values()].flat()]);
      const [observed, legacy] = await Promise.all([
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
      payments = unique([...payments, ...observed, ...legacy]);
      pending = [
        ...new Set([
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
        ...keys
          .filter((key) => /^payment:amount:USD:-?\d+$/u.test(key))
          .map((key) => key.slice("payment:amount:USD:".length)),
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
          sql`${manualEntry.payload}->>${"table"} = 'FinancialTransactionAllocation'
        AND ${manualEntry.payload}->'values'->>'transactionId' = ANY(${textArrayParam(transactionIds)})`,
        ),
        reads.select(
          decision,
          [],
          sql`${decision.channel} = ${decisionChannel.enum.assignment}
        AND ${decision.value}->>${"table"} = 'FinancialTransactionAllocation'
        AND ${decision.value}->'values'->>'transactionId' = ANY(${textArrayParam(transactionIds)})`,
        ),
        reads.select(
          recordKey,
          [],
          sql`${recordKey.scopeKind} = 'purchaseEvent' AND (
        ${recordKey.scopeKey} = ANY(${textArrayParam([...events, ...transactionIds])})
        OR ${recordKey.entityId}::text = ANY(${textArrayParam(orders.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])))})
        OR ${recordKey.entityId}::text IN (SELECT e.id::text FROM "Decision" choice JOIN "Entity" e
          ON e.id::text = choice.value #>> '{}' OR e.shortcode = choice.value #>> '{}'
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
    const paymentsFor: PaymentsFor = (order) =>
      input.payments.filter((payment) => belongs(payment, order));
    const heads = acceptedOrderHeads(input.orders, c);
    const events = new Map(heads.map((row) => [paymentSetKey(row), row]));
    for (const order of events.values()) {
      if (
        !heads.some(
          (row) =>
            orderEventKey(row) === orderEventKey(order) &&
            orderPaymentKeys(row).includes(input.key),
        )
      )
        continue;
      const amountKeys = [
        ...new Set(
          heads
            .filter((row) => paymentSetKey(row) === paymentSetKey(order))
            .flatMap(orderPaymentKeys),
        ),
      ].filter((key) => key.startsWith("payment:amount:"));
      if (!input.key.startsWith("payment:amount:") && amountKeys.length) {
        for (const key of amountKeys) c.emit({ kind: "purchaseEvent", key });
        continue;
      }
      const event = orderEventKey(order);
      const plan = planOrder(input, order, c, paymentsFor);
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
          actions: plan.candidates.flatMap((candidate) => [
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
        const contenders = [...events.values()].filter((other) => {
          const proposed = planOrder(input, other, c, paymentsFor);
          return (
            proposed.kind === "planned" &&
            proposed.matches?.some(
              (row) => row.transactionId === match.transactionId,
            )
          );
        });
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
        const selected = contenders.filter(
          (other) =>
            c.decision(
              "identity",
              orderEventKey(other),
              recordSubject("financialTransaction", match.transactionId),
            )?.kind === "same",
        );
        if (selected.length === 1 && selected[0]?.id === order.id) continue;
        const transaction = input.transactions.find(
          (row) => row.id === match.transactionId,
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
        if (
          !combinedChargeAllocations({
            amountMinor: transaction.amount,
            memberIds: members.map((row) => row.id),
            hasAllocation: false,
            purchases: members,
          })
        )
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
        [...events.values()]
          .filter((other) => {
            const p = planOrder(input, other, c, paymentsFor);
            return (
              p.kind === "planned" &&
              p.matches?.some(
                (row) => row.transactionId === existingBankEvent.transactionId,
              )
            );
          })
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
      if (
        !plan.payments.length ||
        (plan.payments[0] &&
          paymentAmountKey(plan.payments[0].amountMinor) === input.key)
      )
        for (const head of heads.filter(
          (row) => paymentSetKey(row) === paymentSetKey(order),
        ))
          c.bind(
            { kind: orderEvidence.kind, id: head.id },
            resolvedEvent,
            "proven",
          );
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
      c.emit({ kind: "purchaseEvent", key: resolvedScope });
    }
    return c.done();
  },
};
