import { sourceActor } from "@cubby/schemas/kernel/stage";

import { allocationSetViolation } from "~/server/domains/financial-transaction/policy/allocation-set";
import type { Input } from "~/server/domains/financial-transaction/repo/purchase-event";
import {
  purchaseRecords,
  expenseRecords,
  allocationRecords,
  attributionRecords,
  bookingVendors,
} from "~/server/domains/financial-transaction/repo/purchase-event-records";
import { recordPurchaseValue } from "~/server/domains/financial-transaction/repo/purchase-record";
import {
  orderEventKey,
  paymentBankEventKey,
} from "~/server/domains/purchase-import/policy/payment-keys";
import { replacementAttributions } from "~/server/domains/purchase-import/policy/replacement-attributions";
import { replacementLineFields } from "~/server/domains/purchase-import/policy/replacement-lines";
import { acceptedOrderHeads } from "~/server/domains/purchase-import/repo/payment-match";
import type { Pure } from "~/server/kernel/api";
import { recordIdentity, recordSubject } from "~/server/kernel/api";

const targets = [
  purchaseRecords,
  expenseRecords,
  allocationRecords,
  attributionRecords,
  bookingVendors,
];
const keep = (c: Pure) => {
  for (const target of targets)
    for (const key of c.existing(target)) c.retire(target, key, "keep");
  return c.done();
};
const ownKeyFor = (c: Pure, target: typeof purchaseRecords, id: string) =>
  c.existing(target).find((key) => c.recordId(target, key) === id);

/** Accepted order facts complete the same purchase event in either arrival order. */
// oxlint-disable-next-line complexity -- source identity, recorded decisions and exact conservation are one atomic money plan.
export function reconcileOrderPurchase(input: Input, c: Pure) {
  const heads = acceptedOrderHeads(input.orders.map((row) => row.observation));
  const sourceHeads = input.orders.filter((row) =>
    heads.some((head) => head.id === row.observation.id),
  );
  const bindings = input.orderBindings;
  const sourceScope = (id: string) => {
    const candidates = bindings.filter(
      (binding) =>
        binding.fact.kind === "orderObservation" && binding.fact.id === id,
    );
    const accepted =
      candidates.find((row) => row.basis === "decision") ??
      candidates.find((row) => row.basis === "baseline") ??
      candidates[0];
    return accepted?.basis === "baseline" &&
      accepted.scope.kind === "purchaseEvent"
      ? accepted.scope.key
      : accepted?.eventKey;
  };
  const currentBank = input.transactions.find(
    (row) => row.id === input.key && !row.deletedAt,
  );
  const linkedOrders = sourceHeads.filter((row) =>
    input.payments.some(
      (payment) =>
        payment.orderObservationId === row.observation.id &&
        bindings.some(
          (binding) =>
            binding.fact.kind === "retainedPayment" &&
            binding.fact.id === payment.id &&
            binding.eventKey === paymentBankEventKey(input.key),
        ),
    ),
  );
  const ownOrders = sourceHeads.filter(
    (row) =>
      sourceScope(row.observation.id) === input.key ||
      (!row.observation.extraction.candidate?.payments.length &&
        orderEventKey(row.observation) === input.key),
  );

  if (currentBank && linkedOrders.length && !ownOrders.length) {
    const destinations = [
      ...new Set(
        linkedOrders.map(
          (row) =>
            sourceScope(row.observation.id) ?? orderEventKey(row.observation),
        ),
      ),
    ];
    const ownId = c
      .existing(purchaseRecords)
      .map((key) => c.recordId(purchaseRecords, key))
      .find((id) => id !== null);
    const other = destinations
      .flatMap((key) => {
        const id = c.reference(
          "purchase",
          recordIdentity(
            { kind: "purchaseEvent", key },
            "Purchase",
            "purchase",
          ),
        );
        return id ? [{ key, id }] : [];
      })
      .sort((a, b) => a.key.localeCompare(b.key))[0];
    if (ownId && other && ownId !== other.id) {
      const decision = c.decision(
        "identity",
        recordSubject("purchase", ownId),
        recordSubject("purchase", other.id),
      );
      if (decision?.kind === "distinct")
        c.gap.decision("the order and bank purchase remain distinct");
      else
        c.merge(
          purchaseRecords,
          ownId,
          other.id,
          decision?.kind === "same" ? "decision" : "proof",
        );
    }
    for (const key of destinations) c.emit({ kind: "purchaseEvent", key });
    return keep(c);
  }
  if (!ownOrders.length) {
    if (!input.key.startsWith("order:")) return null;
    const observed = sourceHeads.filter(
      (row) => orderEventKey(row.observation) === input.key,
    );
    if (observed.length) {
      for (const row of observed) {
        const scope = sourceScope(row.observation.id);
        if (scope && scope !== input.key)
          c.emit({ kind: "purchaseEvent", key: scope });
      }
      c.gap.evidence("a resolved payment identity for the order", "an agent");
    }
    return keep(c);
  }
  const confirmations = ownOrders.filter((row) => !row.refund);
  const accepted =
    confirmations.sort(
      (a, b) =>
        b.observation.createdAt.getTime() - a.observation.createdAt.getTime() ||
        b.observation.id.localeCompare(a.observation.id),
    )[0] ?? ownOrders[0]!;
  const candidate = accepted.observation.extraction.candidate;
  if (
    !candidate ||
    accepted.policy.skipsLineWrites ||
    !accepted.date ||
    accepted.totalMinor === null
  ) {
    c.gap.evidence(
      `order details: ${accepted.policy.semanticPlan.writeBlockReason ?? "missing accepted order"}`,
      "an agent",
    );
    return keep(c);
  }
  const principal = accepted.lines.filter(
    (line) => line.lineKind === "principal",
  );
  const pricedTotal = accepted.lines.reduce(
    (sum, line) => sum + (line.amountMinor ?? 0n),
    0n,
  );
  if (
    accepted.lines.some((line) => line.amountMinor === null) ||
    pricedTotal !== accepted.totalMinor
  ) {
    c.gap.evidence(
      "priced order lines that conserve the accepted total",
      "an agent",
    );
    return keep(c);
  }
  const purchaseKey = c.existing(purchaseRecords)[0] ?? "purchase";
  const purchaseIdentity = c.identity(purchaseRecords, purchaseKey);
  const existingPurchase = input.purchases.find(
    (row) => row.id === purchaseIdentity.id && !row.deletedAt,
  );
  const otherOrderOwner = input.purchases.find(
    (row) =>
      !row.deletedAt &&
      row.id !== purchaseIdentity.id &&
      row.vendorId === accepted.observation.vendorId &&
      row.orderId === candidate.orderId,
  );
  if (otherOrderOwner) {
    const identity = c.decision(
      "identity",
      recordSubject("purchase", purchaseIdentity.id),
      recordSubject("purchase", otherOrderOwner.id),
    );
    if (identity?.kind !== "same") {
      c.gap.decision("whether these order records are the same", {
        actions: [
          {
            channel: "identity",
            kind: "same",
            subject: recordSubject("purchase", purchaseIdentity.id),
            field: recordSubject("purchase", otherOrderOwner.id),
            label: "Same purchase",
          },
          {
            channel: "identity",
            kind: "distinct",
            subject: recordSubject("purchase", purchaseIdentity.id),
            field: recordSubject("purchase", otherOrderOwner.id),
            label: "Different purchases",
          },
        ],
      });
      return keep(c);
    }
    c.merge(
      purchaseRecords,
      purchaseIdentity.id,
      otherOrderOwner.id,
      "decision",
    );
    return keep(c);
  }
  const oldLump = input.expenses.find(
    (row) =>
      row.purchaseId === purchaseIdentity.id &&
      row.lineBasis === "allocation" &&
      row.economicRole !== "reimbursement",
  );
  const lumpChoices = oldLump
    ? c.assignments(recordSubject("expense", oldLump.id))
    : new Map();
  const acceptedLump = oldLump
    ? {
        ...oldLump,
        ...Object.fromEntries(
          [...lumpChoices].map(([field, held]) => [
            field,
            held.kind === "none" ? null : held.value,
          ]),
        ),
      }
    : null;
  if (oldLump) {
    const held = c.assignments(recordSubject("expense", oldLump.id));
    if (held.has("cost") || (principal.length > 1 && held.has("productId"))) {
      c.gap.decision(
        "how the recorded lump cost or Product maps to the order lines",
      );
      return keep(c);
    }
  }
  const subject = `purchaseEvent:${input.key}`;
  const header = c.assignments(subject);
  const headerValue = (field: string, fallback: unknown) => {
    const chosen = header.get(field);
    return chosen ? (chosen.kind === "none" ? null : chosen.value) : fallback;
  };
  const purchaseId = recordPurchaseValue(
    c,
    purchaseRecords,
    purchaseKey,
    {
      vendorId: accepted.observation.vendorId,
      vendorAccountId: existingPurchase?.vendorAccountId ?? null,
      orderId: candidate.orderId,
      displayLabel: candidate.merchant,
      date: accepted.date,
      statedTotal: accepted.totalMinor,
      defaultTrade: headerValue(
        "defaultTrade",
        existingPurchase?.defaultTrade ?? null,
      ),
      defaultProjectId: headerValue(
        "defaultProjectId",
        existingPurchase?.defaultProjectId ?? null,
      ),
      purchaserOverrideId: headerValue(
        "purchaserId",
        existingPurchase?.purchaserOverrideId ?? null,
      ),
      spendingCategoryId: headerValue(
        "spendingCategoryId",
        existingPurchase?.spendingCategoryId ?? null,
      ),
      spendingCategoryOrigin:
        existingPurchase?.spendingCategoryOrigin ?? "source",
      itemizationExpectation: existingPurchase?.itemizationExpectation ?? null,
      notes: existingPurchase?.notes ?? null,
      ...(!existingPurchase ? { runId: accepted.observation.runId } : {}),
    },
    Object.fromEntries(
      [...header]
        .filter(([field]) => purchaseRecords.columns.includes(field))
        .map(([field, choice]) => [field, choice.id]),
    ),
  );
  const keptExpenses = new Set<string>();
  const keptAttributions = new Set<string>();
  const keptAllocations = new Set<string>();
  const allLines = [
    accepted,
    ...ownOrders.filter(
      (row) => row.refund && row.observation.id !== accepted.observation.id,
    ),
  ];
  const carriedAttributions = oldLump
    ? replacementAttributions({
        allocations: input.lumpAttributions.filter(
          (row) => row.expenseId === oldLump.id && row.basis === "recorded",
        ),
        lines: accepted.lines,
      })
    : [];
  for (const order of allLines)
    for (const line of order.lines) {
      const key = `${order.refund ? `refund:${order.observation.id}:` : ""}line:${line.lineIndex}`;
      const carried = oldLump
        ? replacementLineFields({
            aggregate: acceptedLump!,
            title: line.title,
            seller: line.seller,
            costMinor: line.amountMinor,
            lineKind: line.lineKind,
          })
        : null;
      const previousDecisions = oldLump
        ? c.assignments(recordSubject("expense", oldLump.id))
        : new Map();
      const provenance: Record<string, string> = {};
      for (const field of [
        "spendingCategoryId",
        "projectId",
        "trade",
        "costType",
        "notes",
      ]) {
        const held = previousDecisions.get(field);
        if (held) provenance[field] = held.id;
      }
      const expenseId = recordPurchaseValue(
        c,
        expenseRecords,
        key,
        {
          name: line.title,
          cost: line.amountMinor,
          date: order.date,
          purchaseId,
          lineKind: line.lineKind,
          lineBasis: "item_line",
          economicRole: "vendor",
          future: false,
          costType:
            line.costType ??
            carried?.costType ??
            (line.lineKind === "principal" ? "materials" : "services"),
          trade: carried?.trade ?? null,
          projectId:
            line.lineKind === "principal" ? (carried?.projectId ?? null) : null,
          spendingCategoryId:
            line.lineKind === "principal" &&
            previousDecisions.has("spendingCategoryId")
              ? (carried?.spendingCategoryId ?? null)
              : null,
          notes: carried?.notes ?? null,
          productId: lumpChoices.get("productId")?.value ?? line.productId,
          productQuantity:
            line.productId || lumpChoices.has("productId")
              ? (line.quantity ?? 1)
              : null,
          url: line.productUrl ?? null,
          bookingTransactionCode: oldLump?.bookingTransactionCode ?? null,
        },
        provenance,
      );
      keptExpenses.add(key);
      for (const share of carriedAttributions.filter(
        (row) => !order.refund && row.lineIndex === line.lineIndex,
      )) {
        const attributionKey = `${key}:${share.role}:${share.partyCode}`;
        recordPurchaseValue(c, attributionRecords, attributionKey, {
          expenseId,
          role: share.role,
          ledgerPartyId: share.partyId,
          weight: Number(share.weightMinor),
        });
        keptAttributions.add(attributionKey);
      }
      const owner = headerValue(
        "purchaserId",
        existingPurchase?.purchaserOverrideId ?? null,
      );
      if (
        typeof owner === "string" &&
        !carriedAttributions.some((row) => row.role === "beneficiary")
      ) {
        const attributionKey = `${key}:beneficiary`;
        recordPurchaseValue(c, attributionRecords, attributionKey, {
          expenseId,
          role: "beneficiary",
          ledgerPartyId: owner,
          weight: 1,
        });
        keptAttributions.add(attributionKey);
      }
    }
  const payments = input.payments.filter((row) =>
    ownOrders.some((order) => row.orderObservationId === order.observation.id),
  );
  const matched = new Map<string, bigint>();
  for (const payment of payments) {
    const binding =
      bindings.find(
        (row) =>
          row.fact.kind === "retainedPayment" &&
          row.fact.id === payment.id &&
          row.basis === "decision",
      ) ??
      bindings.find(
        (row) =>
          row.fact.kind === "retainedPayment" && row.fact.id === payment.id,
      );
    if (!binding?.eventKey.startsWith("bank:")) continue;
    const transactionId = binding.eventKey.slice(5);
    const transaction = input.transactions.find(
      (row) => row.id === transactionId && !row.deletedAt,
    );
    if (!transaction) continue;
    const claims = sourceHeads.filter((other) =>
      input.payments.some(
        (row) =>
          row.orderObservationId === other.observation.id &&
          bindings.some(
            (link) =>
              link.fact.kind === "retainedPayment" &&
              link.fact.id === row.id &&
              link.eventKey === binding.eventKey,
          ),
      ),
    );
    const unique = new Map(
      claims.map((row) => [orderEventKey(row.observation), row]),
    );
    const combined = unique.size > 1;
    const amount = combined
      ? (ownOrders.find(
          (row) => row.observation.id === payment.orderObservationId,
        )?.totalMinor ?? payment.amountMinor)
      : payment.amountMinor;
    if (
      combined &&
      [...unique.values()].reduce(
        (sum, row) => sum + (row.totalMinor ?? 0n),
        0n,
      ) !== transaction.amount
    ) {
      c.disagree(
        "the combined order payment no longer conserves its bank charge",
      );
      return c.done();
    }
    matched.set(transactionId, amount);
  }
  for (const [transactionId, amountMinor] of matched) {
    const transaction = input.transactions.find(
      (row) => row.id === transactionId,
    )!;
    const claims = sourceHeads.filter((other) =>
      input.payments.some(
        (row) =>
          row.orderObservationId === other.observation.id &&
          bindings.some(
            (link) =>
              link.fact.kind === "retainedPayment" &&
              link.fact.id === row.id &&
              link.eventKey === paymentBankEventKey(transactionId),
          ),
      ),
    );
    const slices = [
      ...new Map(
        claims.map((row) => [orderEventKey(row.observation), row]),
      ).values(),
    ].map((row) => ({
      purchaseId: orderEventKey(row.observation),
      amountMinor:
        claims.length > 1 ? (row.totalMinor ?? 0n) : transaction.amount,
    }));
    const violation = allocationSetViolation({
      transactionAmountMinor: transaction.amount,
      kind: transaction.kind,
      next: slices,
    });
    if (violation) {
      c.disagree(violation);
      return c.done();
    }
    const saved = input.allocations.find(
      (row) =>
        !row.deletedAt &&
        row.purchaseId === purchaseId &&
        row.transactionId === transactionId,
    );
    const key =
      (saved ? ownKeyFor(c, allocationRecords, saved.id) : null) ??
      `allocation:${transactionId}`;
    recordPurchaseValue(c, allocationRecords, key, {
      transactionId,
      purchaseId,
      amountMinor,
      confirmsMerchant: true,
    });
    keptAllocations.add(key);
  }
  for (const [target, keys] of [
    [expenseRecords, keptExpenses],
    [allocationRecords, keptAllocations],
    [attributionRecords, keptAttributions],
  ] as const)
    for (const key of c.existing(target))
      if (!keys.has(key)) c.retire(target, key, "remove");
  for (const key of c.existing(bookingVendors))
    c.retire(bookingVendors, key, "keep");
  if (!matched.size) c.gap.evidence("the bank charge", sourceActor("the bank"));
  return c.done();
}
