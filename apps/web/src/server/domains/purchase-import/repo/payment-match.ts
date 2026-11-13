import { cardLastFoursOn } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { decisionChannel } from "@cubby/schemas/kernel/stage";
import { statementMerchantKey } from "@cubby/schemas/statement-answers";
import { moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { decision, manualEntry } from "~/server/db/kernel-schema";
import {
  financialAccount,
  financialTransaction,
  purchasePaymentEvidence,
  sourceOrderObservation,
  vendor,
} from "~/server/db/schema";
import { allocationSetViolation } from "~/server/domains/financial-transaction/policy/allocation-set";
import { combinedChargeAllocations } from "~/server/domains/purchase-import/policy/combined-charge";
import { paymentBankEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
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
  bindingWrites,
  defineReconciler,
  recordIdentity,
  recordSubject,
  source,
  type Binding,
  type Pure,
} from "~/server/kernel/api";

type Order = typeof sourceOrderObservation.$inferSelect;
type Payment = typeof purchasePaymentEvidence.$inferSelect;
type Movement = typeof financialTransaction.$inferSelect;
type Input = {
  key: string;
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
export function acceptedOrderHeads(orders: readonly Order[]) {
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
  return [...heads.values()];
}

const paymentSetKey = (order: Order) =>
  `${orderEventKey(order)}:${order.extraction.candidate?.sourceEvent === "refunded" ? "refund" : "charge"}`;
const paymentsFor = (input: Input, order: Order) =>
  input.payments.filter(
    (payment) =>
      payment.orderObservationId === order.id ||
      (!!order.sourceClaimId &&
        payment.sourceClaimId === order.sourceClaimId &&
        payment.purchaseId === order.purchaseId),
  );
const bindingFor = (input: Input, kind: string, id: string) =>
  input.bindings
    .filter((binding) => binding.fact.kind === kind && binding.fact.id === id)
    .sort(
      (a, b) => Number(b.basis === "baseline") - Number(a.basis === "baseline"),
    )[0];

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
function recordedAllocations(input: Input, c: Pure, transactionId: string) {
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

function choices(input: Input, order: Order, c: Pure): ChargeMatchRead[] {
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
      transaction.ledgerTransferId ||
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
        !paymentsFor(input, order).some(
          (payment) => payment.id === binding.fact.id,
        ) &&
        !input.orders.some(
          (other) =>
            other.id !== order.id &&
            orderEventKey(other) === event &&
            paymentsFor(input, other).some(
              (payment) => payment.id === binding.fact.id,
            ),
        ),
    );
    if (occupied && decision?.kind !== "same") {
      const related = input.orders.some(
        (other) =>
          other.id !== order.id &&
          paymentsFor(input, other).some(
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

function planOrder(input: Input, order: Order, c: Pure) {
  const sameEvent = acceptedOrderHeads(input.orders).filter(
    (row) => paymentSetKey(row) === paymentSetKey(order),
  );
  const rows = sameEvent.flatMap((row) => paymentsFor(input, row));
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
  const candidates =
    total !== null && total !== undefined && abs(paid) < abs(total)
      ? []
      : choices(input, order, c);
  const explicit = candidates.filter(
    (candidate) =>
      c.decision(
        "identity",
        orderEventKey(order),
        recordSubject("financialTransaction", candidate.id),
      )?.kind === "same",
  );
  const matches = completePaymentMatches(
    payments,
    explicit.length ? explicit : candidates,
  );
  return { kind: "planned" as const, rows, payments, candidates, matches };
}

export const paymentMatch = defineReconciler<Input>({
  scope: "paymentMatch",
  lane: "money",
  version: 1,
  after: ["bankEvent"],
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
    source.table(purchasePaymentEvidence, [
      "orderObservationId",
      "sourceClaimId",
      "purchaseId",
      "amountMinor",
      "chargedAt",
      "cardLastFour",
      "tender",
      "evidenceIndex",
    ]),
    source.table(financialTransaction, [
      "accountId",
      "amount",
      "kind",
      "status",
      "transactionDate",
      "postedDate",
      "merchant",
      "ledgerTransferId",
      "deletedAt",
    ]),
    source.table(financialAccount, [
      "ledgerPartyId",
      "identity",
      "cardNumbers",
      "deletedAt",
    ]),
    source.table(vendor, ["name", "aliases", "deletedAt"]),
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
  writes: [bindingWrites],
  async load(reads, keys) {
    const [
      orders,
      payments,
      transactions,
      accounts,
      vendors,
      manuals,
      recordDecisions,
    ] = await Promise.all([
      reads.select(sourceOrderObservation, keys, sql`true`),
      reads.select(purchasePaymentEvidence, keys, sql`true`),
      reads.select(financialTransaction, keys, sql`true`),
      reads.select(financialAccount, [], sql`true`),
      reads.select(vendor, [], sql`true`),
      reads.select(manualEntry, [], sql`true`),
      reads.select(
        decision,
        [],
        sql`${decision.channel} = ${decisionChannel.enum.assignment} AND ${decision.value}->>${"table"} = ${"FinancialTransactionAllocation"}`,
      ),
    ]);
    const bindings = await reads.bindings({
      facts: [
        ...orders.map((row) => ({ kind: orderEvidence.kind, id: row.id })),
        ...payments.map((row) => ({
          kind: retainedPaymentEvidence.kind,
          id: row.id,
        })),
      ],
    });
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
          payments,
          transactions,
          accounts,
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
    const heads = acceptedOrderHeads(input.orders);
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
      if (!input.key.startsWith("payment:amount:")) {
        for (const key of orderPaymentKeys(order).filter((key) =>
          key.startsWith("payment:amount:"),
        ))
          c.emit({ kind: "paymentMatch", key });
        continue;
      }
      const event = orderEventKey(order);
      const plan = planOrder(input, order, c);
      if (plan.kind === "conflicting") {
        c.gap.evidence("agreeing retained payment evidence", "an agent");
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
          const proposed = planOrder(input, other, c);
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
            total !== match.amountMinor
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
        heads
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
            const p = planOrder(input, other, c);
            return (
              p.kind === "planned" &&
              p.matches?.some(
                (row) => row.transactionId === existingBankEvent.transactionId,
              )
            );
          })
          .map(orderEventKey)
          .sort()[0] === event;
      const resolvedEvent =
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
        plan.payments[0] &&
        paymentAmountKey(plan.payments[0].amountMinor) === input.key
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
});
