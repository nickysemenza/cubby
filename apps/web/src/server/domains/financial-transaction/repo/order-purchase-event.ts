import { parseEntityId } from "@cubby/schemas/identifiers";
import { sourceActor } from "@cubby/schemas/kernel/stage";
import { minorToMoney } from "@cubby/shared";

import { allocationSetViolation } from "~/server/domains/financial-transaction/policy/allocation-set";
import type { Input } from "~/server/domains/financial-transaction/repo/purchase-event-input";
import {
  purchaseRecords,
  restorePurchaseValues,
  expenseRecords,
  allocationRecords,
  attributionRecords,
  bookingVendors,
} from "~/server/domains/financial-transaction/repo/purchase-event-records";
import {
  recordPurchaseValue,
  retainPurchaseValue,
} from "~/server/domains/financial-transaction/repo/purchase-record";
import { planLineMatch } from "~/server/domains/purchase-import/policy/accepted-source";
import {
  orderEventKey,
  paymentBankEventKey,
  createOrderPaymentMatcher,
} from "~/server/domains/purchase-import/policy/payment-keys";
import { replacementAttributions } from "~/server/domains/purchase-import/policy/replacement-attributions";
import { replacementLineFields } from "~/server/domains/purchase-import/policy/replacement-lines";
import { acceptedOrderHeads } from "~/server/domains/purchase-import/repo/payment-match";
import type { ColumnRef, Pure } from "~/server/kernel/api";
import {
  recordIdentity,
  recordSubject,
  effectiveBindings,
} from "~/server/kernel/api";

const targets = [
  purchaseRecords,
  expenseRecords,
  allocationRecords,
  attributionRecords,
  bookingVendors,
];
const keep = (c: Pure) => {
  for (const target of targets)
    for (const key of c.existing(target)) retainPurchaseValue(c, target, key);
  return c.done();
};
const ownKeyFor = (c: Pure, target: ColumnRef, id: string) =>
  c.existing(target).find((key) => c.recordId(target, key) === id);

/** Accepted order facts complete the same purchase event in either arrival order. */
// oxlint-disable-next-line complexity -- source identity, recorded decisions and exact conservation are one atomic money plan.
export function reconcileOrderPurchase(
  input: Input,
  c: Pure,
  seeds: readonly {
    target: ColumnRef;
    naturalKey: string;
    values: Parameters<Pure["record"]>[2];
    fact?: string;
    decision?: string;
    baseline?: boolean;
  }[] = [],
) {
  const write = (
    target: ColumnRef,
    naturalKey: string,
    values: Parameters<Pure["record"]>[2],
    provenance: Record<string, string> = {},
  ) => {
    const seed = seeds.find(
      (seed) => seed.target === target && seed.naturalKey === naturalKey,
    );
    const proposed = seed?.baseline
      ? { ...seed.values, ...values }
      : { ...values, ...seed?.values };
    if (
      target === purchaseRecords &&
      seed &&
      !seed.baseline &&
      seed.values.defaultTrade == null &&
      seed.values.defaultProjectId == null &&
      c.stored(target, naturalKey)?.defaultProjectId == null &&
      values.defaultTrade != null &&
      !input.expenses.some(
        (row) =>
          row.purchaseId === c.identity(target, naturalKey).id &&
          !row.deletedAt &&
          (row.trade || row.projectId),
      )
    )
      proposed.defaultTrade = values.defaultTrade;
    return recordPurchaseValue(
      c,
      target,
      naturalKey,
      proposed,
      {
        ...provenance,
        ...(seed?.decision
          ? Object.fromEntries(
              Object.keys(seed.values).map((field) => [field, seed.decision!]),
            )
          : {}),
      },
      !!seed && !seed.baseline,
    );
  };
  const manualAllocations = seeds.filter(
    (seed) => seed.target === allocationRecords,
  );

  const orderObservations = input.orders.map((row) => row.observation);
  const paymentBelongsToOrder = createOrderPaymentMatcher(
    orderObservations,
    input.payments,
  );
  const heads = acceptedOrderHeads(orderObservations);
  for (const row of heads)
    if (row.emailId) c.emit({ kind: "emailState", key: row.emailId });
  const sourceHeads = input.orders.filter((row) =>
    heads.some((head) => head.id === row.observation.id),
  );
  const bindings = input.orderBindings;
  const sourceScope = (id: string) => {
    const accepted = effectiveBindings(bindings).find(
      (binding) =>
        binding.fact.kind === "orderObservation" && binding.fact.id === id,
    );
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
        paymentBelongsToOrder(payment, row.observation) &&
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
      (!sourceScope(row.observation.id) &&
        !row.observation.extraction.candidate?.payments.length &&
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
      c.gap.evidence("a resolved payment identity for the order", "agent");
    }
    return keep(c);
  }
  const confirmations = ownOrders.filter((row) => !row.refund);
  const complete = confirmations.filter(
    (row) =>
      row.policy.writesLines &&
      row.date &&
      (row.policy.unpriced || row.totalMinor !== null),
  );
  const accepted =
    (complete.length ? complete : confirmations).sort(
      (a, b) =>
        b.observation.createdAt.getTime() - a.observation.createdAt.getTime() ||
        b.observation.id.localeCompare(a.observation.id),
    )[0] ?? ownOrders[0]!;
  const candidate = accepted.observation.extraction.candidate;
  if (!candidate) {
    c.gap.evidence("readable order details", "agent");
    return keep(c);
  }
  const purchaseKey = c.existing(purchaseRecords)[0] ?? "purchase";
  const purchaseIdentity = c.identity(purchaseRecords, purchaseKey);
  const existingPurchase = input.purchases.find(
    (row) => row.id === purchaseIdentity.id && !row.deletedAt,
  );
  const scopeChoices = new Map(c.assignments(`purchaseEvent:${input.key}`));
  for (const key of new Set([
    input.key,
    ...ownOrders.map((row) => orderEventKey(row.observation)),
  ]))
    for (const [field, choice] of c.assignments(`purchaseEvent:${key}`)) {
      const previous = scopeChoices.get(field);
      if (
        !previous ||
        choice.at.getTime() > previous.at.getTime() ||
        (choice.at.getTime() === previous.at.getTime() &&
          choice.id > previous.id)
      )
        scopeChoices.set(field, choice);
    }
  const header = scopeChoices;
  const receiptDateNote =
    "Order date uses email receipt time because the confirmation supplies no order date.";
  const headerValue = (field: string, fallback: unknown) => {
    const chosen = header.get(field);
    return chosen ? (chosen.kind === "none" ? null : chosen.value) : fallback;
  };
  const publishHeader = () =>
    write(
      purchaseRecords,
      purchaseKey,
      {
        vendorId: accepted.observation.vendorId,
        vendorAccountId: existingPurchase?.vendorAccountId ?? null,
        orderId: candidate.orderId,
        displayLabel: candidate.merchant,
        date: accepted.date ?? existingPurchase?.date ?? null,
        statedTotal:
          accepted.totalMinor ?? existingPurchase?.statedTotal ?? null,
        defaultTrade:
          existingPurchase?.defaultTrade ??
          (existingPurchase?.defaultProjectId ||
          input.expenses.some(
            (row) =>
              row.purchaseId === purchaseIdentity.id &&
              !row.deletedAt &&
              (row.trade || row.projectId),
          )
            ? null
            : headerValue("defaultTrade", null)),
        defaultProjectId:
          existingPurchase?.defaultProjectId ??
          headerValue(
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
        itemizationExpectation:
          existingPurchase?.itemizationExpectation ?? null,
        notes:
          accepted.dateFromReceipt &&
          !existingPurchase?.notes?.includes(receiptDateNote)
            ? [existingPurchase?.notes, receiptDateNote]
                .filter(Boolean)
                .join("\n\n")
            : (existingPurchase?.notes ?? null),
        ...(!existingPurchase ? { runId: accepted.observation.runId } : {}),
      },
      Object.fromEntries(
        [...header]
          .filter(([field]) => purchaseRecords.columns.includes(field))
          .map(([field, choice]) => [field, choice.id]),
      ),
    );
  if (
    !accepted.policy.writesLines ||
    !accepted.date ||
    (!accepted.policy.unpriced && accepted.totalMinor === null)
  ) {
    publishHeader();
    c.gap.evidence(
      `order details: ${accepted.policy.semanticPlan.writeBlockReason ?? "missing accepted order"}`,
      "agent",
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
    !accepted.policy.unpriced &&
    (accepted.lines.some((line) => line.amountMinor === null) ||
      pricedTotal !== accepted.totalMinor)
  ) {
    c.gap.evidence(
      "priced order lines that conserve the accepted total",
      "agent",
    );
    return keep(c);
  }
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
      !row.deletedAt &&
      row.purchaseId === purchaseIdentity.id &&
      row.lineBasis === "allocation" &&
      row.economicRole !== "reimbursement",
  );
  // Itemization cannot add priced spending while another event still owns
  // the bank aggregate. A reviewed ownership change must retire it first.
  if (
    oldLump &&
    !accepted.policy.unpriced &&
    !ownKeyFor(c, expenseRecords, oldLump.id)
  ) {
    c.gap.decision(
      "how recorded aggregate spending transfers to the priced order lines",
    );
    return keep(c);
  }
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
  const unlinkedSpending = accepted.lines.some((line) => {
    const resolution = scopeChoices.get(
      `line:${line.binding?.stableLineId ?? line.lineIndex}`,
    );
    const value = resolution?.value;
    const productId =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.kind === "existing" &&
      typeof value.productId === "string"
        ? c.reference("product", value.productId)
        : line.productId;
    return (
      productId &&
      input.expenses.some(
        (row) =>
          !row.deletedAt &&
          !row.purchaseId &&
          row.productId === productId &&
          row.date === accepted.date &&
          row.cost !== null &&
          row.cost === line.amountMinor &&
          row.cost >= 0n &&
          (row.productQuantity ?? 1) > 0,
      )
    );
  });
  const currentLines = input.expenses
    .filter(
      (row) =>
        row.purchaseId === purchaseIdentity.id &&
        !row.deletedAt &&
        row.lineBasis === "item_line",
    )
    .map((row) => {
      const projected = { ...row };
      for (const [field, choice] of c.assignments(
        recordSubject("expense", row.id),
      ))
        if (expenseRecords.columns.includes(field))
          Object.assign(
            projected,
            restorePurchaseValues({
              [field]: choice.kind === "none" ? null : choice.value,
            }),
          );
      return projected;
    });
  const lineMatch = planLineMatch(
    candidate,
    currentLines.map((row) => ({
      id: row.id,
      title: row.name,
      amount: row.cost === null ? null : minorToMoney(row.cost),
      lineKind: row.lineKind,
      productId: row.productId,
      tradeId: row.trade,
      projectId: row.projectId,
      costType: row.costType,
      sourceClaimed: true,
      lineBasis: row.lineBasis,
      productQuantity: row.productQuantity,
    })),
    accepted.policy.unpriced,
    accepted.policy.valuation,
    {
      sources: input.orders.map(({ observation }) => ({
        id: observation.id,
        originalOrder: {
          checksum: observation.checksum,
          extraction: observation.extraction,
        },
      })),
      bindings: input.orders.flatMap(({ observation }) =>
        observation.productBindings.map((binding) => ({
          sourceOrderId: observation.id,
          lineIndex: binding.lineIndex,
          expenseId: (() => {
            const held = scopeChoices.get(
              `line-record:${binding.stableLineId ?? binding.lineIndex}`,
            );
            const id =
              held?.kind === "none"
                ? null
                : (binding.legacyExpenseId ??
                  c.recordId(
                    expenseRecords,
                    `line:${binding.stableLineId ?? binding.lineIndex}`,
                  ) ??
                  (held?.kind === "set" && typeof held.value === "string"
                    ? held.value
                    : null));
            return id ? parseEntityId("expense", id) : null;
          })(),
        })),
      ),
    },
  );
  const mapped = accepted.lines.every(
    (line) =>
      line.binding?.legacyExpenseId ||
      lineMatch.originalExpenses.has(line.lineIndex) ||
      scopeChoices.has(
        `line-record:${line.binding?.stableLineId ?? line.lineIndex}`,
      ),
  );
  if (lineMatch.decision.kind === "conflict" && !mapped) {
    c.gap.decision("how the new source corresponds to recorded item spending");
    c.disagree("new source itemization contradicts recorded spending");
    return keep(c);
  }
  const usedLines = new Set<string>();
  const purchaseId = publishHeader();
  if (unlinkedSpending) {
    c.gap.decision(
      "how this order corresponds to existing unlinked item spending",
    );
    return keep(c);
  }
  const keptExpenses = new Set<string>();
  const keptAttributions = new Set<string>();
  const keptAllocations = new Set<string>();
  const allLines = [
    accepted,
    ...ownOrders.filter(
      (row) => row.refund && row.observation.id !== accepted.observation.id,
    ),
  ];
  const carriedAttributions =
    oldLump && !accepted.policy.unpriced
      ? replacementAttributions({
          allocations: input.lumpAttributions.filter(
            (row) => row.expenseId === oldLump.id && row.basis === "recorded",
          ),
          lines: accepted.lines,
        })
      : [];
  if (accepted.policy.unpricedItemization && accepted.totalMinor !== null) {
    const existingKey = oldLump
      ? ownKeyFor(c, expenseRecords, oldLump.id)
      : null;
    // Another event keeps its bank aggregate until a reviewed money change
    // transfers that responsibility; never create a second aggregate beside it.
    if (!oldLump || existingKey) {
      const key = existingKey ?? "order-total";
      write(expenseRecords, key, {
        purchaseId,
        name: oldLump?.name ?? candidate.merchant,
        cost: accepted.totalMinor,
        date: accepted.date,
        lineKind: "principal",
        lineBasis: "allocation",
        economicRole: "vendor",
        costType: oldLump?.costType ?? "materials",
        future: oldLump?.future ?? false,
        productId: null,
        productQuantity: null,
        trade: oldLump?.trade ?? null,
        projectId: oldLump?.projectId ?? null,
        spendingCategoryId: oldLump?.spendingCategoryId ?? null,
        notes: oldLump?.notes ?? null,
        url: oldLump?.url ?? null,
        bookingTransactionCode:
          oldLump?.bookingTransactionCode ?? currentBank?.shortcode ?? null,
      });
      keptExpenses.add(key);
    }
  }
  for (const order of allLines)
    for (const line of order.lines) {
      const retainedLine = scopeChoices.get(
        `line-record:${line.binding?.stableLineId ?? line.lineIndex}`,
      );
      const matches =
        order.refund || retainedLine?.kind === "none"
          ? []
          : lineMatch
              .matchingExpenses(line, line.lineIndex)
              .filter((row) => !usedLines.has(row.id));
      const retainedId =
        retainedLine?.kind === "none"
          ? null
          : (line.binding?.legacyExpenseId ??
            (retainedLine?.kind === "set" &&
            typeof retainedLine.value === "string"
              ? retainedLine.value
              : null));
      if (
        !retainedId &&
        !lineMatch.originalExpenses.has(line.lineIndex) &&
        matches.length > 1
      ) {
        c.gap.decision("which recorded item is this order line");
        c.disagree("multiple recorded items match this source line");
        return keep(c);
      }
      const legacyExpenseId =
        retainedLine?.kind === "none"
          ? undefined
          : (retainedId ??
            lineMatch.originalExpenses.get(line.lineIndex) ??
            matches[0]?.id);
      if (legacyExpenseId && usedLines.has(legacyExpenseId)) {
        c.disagree("one recorded item cannot supply two source lines");
        return keep(c);
      }
      if (legacyExpenseId) usedLines.add(legacyExpenseId);
      const prior = input.expenses.find((row) => row.id === legacyExpenseId);
      const ownedExpenseKey = legacyExpenseId
        ? ownKeyFor(c, expenseRecords, legacyExpenseId)
        : undefined;
      const key = legacyExpenseId
        ? (ownedExpenseKey ?? `accepted:${legacyExpenseId}`)
        : `${order.refund ? `refund:${order.observation.id}:` : ""}line:${line.binding?.stableLineId ?? line.lineIndex}`;
      const resolution = scopeChoices.get(
        `line:${line.binding?.stableLineId ?? line.lineIndex}`,
      );
      const choice =
        resolution?.value &&
        typeof resolution.value === "object" &&
        !Array.isArray(resolution.value)
          ? resolution.value
          : null;
      const heldProduct = c
        .assignments(
          recordSubject(
            "expense",
            legacyExpenseId ?? c.identity(expenseRecords, key).id,
          ),
        )
        .get("productId");
      if (choice?.kind === "new" || (!choice && line.binding?.createProduct)) {
        c.gap.decision("the reviewed Product identity for this accepted item");
        return keep(c);
      }
      const productId = heldProduct
        ? heldProduct.kind === "set" && typeof heldProduct.value === "string"
          ? c.reference("product", heldProduct.value)
          : null
        : choice?.kind === "existing" && typeof choice.productId === "string"
          ? c.reference("product", choice.productId)
          : choice
            ? null
            : (line.productId ?? prior?.productId ?? null);
      if (
        legacyExpenseId &&
        (!ownedExpenseKey || ownedExpenseKey.startsWith("accepted:"))
      ) {
        if (
          c.decision("rejection", recordSubject("expense", legacyExpenseId))
            ?.kind === "reject"
        ) {
          if (ownedExpenseKey) c.retire(expenseRecords, key, "keep");
          keptExpenses.add(key);
          continue;
        }
        if (
          !prior ||
          prior.purchaseId !== purchaseId ||
          (!order.policy.unpriced && prior.cost !== line.amountMinor) ||
          prior.productId !== productId
        ) {
          c.gap.decision(
            "the reviewed correspondence to the independently recorded item",
          );
          c.disagree(
            "an independently owned item must be updated by its own reviewed decisions",
          );
          return keep(c);
        }
        // The original event remains the sole writer. This order retains a
        // reference, as bank occurrences do for accepted transactions.
        c.attach(expenseRecords, key, legacyExpenseId);
        if (ownedExpenseKey) c.retire(expenseRecords, key, "keep");
        keptExpenses.add(key);
        continue;
      }
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
      const provenance: Record<string, string> = resolution
        ? { productId: resolution.id, productQuantity: resolution.id }
        : {};
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
      const expenseId = write(
        expenseRecords,
        key,
        {
          name: line.title,
          cost: order.policy.unpriced
            ? (prior?.cost ?? null)
            : line.amountMinor,
          date: order.date,
          purchaseId,
          lineKind: line.lineKind,
          lineBasis: "item_line",
          economicRole: "vendor",
          future: false,
          costType:
            line.costType ??
            prior?.costType ??
            carried?.costType ??
            (line.lineKind === "principal" && choice?.kind !== "expense_only"
              ? "materials"
              : "services"),
          trade: prior?.trade ?? carried?.trade ?? null,
          projectId:
            line.lineKind === "principal"
              ? (prior?.projectId ?? carried?.projectId ?? null)
              : null,
          spendingCategoryId:
            line.lineKind === "principal"
              ? (prior?.spendingCategoryId ??
                (previousDecisions.has("spendingCategoryId")
                  ? carried?.spendingCategoryId
                  : null) ??
                null)
              : null,
          notes: prior?.notes ?? carried?.notes ?? null,
          productId: lumpChoices.get("productId")?.value ?? productId,
          productQuantity:
            productId || lumpChoices.has("productId")
              ? (line.quantity ??
                prior?.productQuantity ??
                (order.policy.unpriced ? null : 1))
              : null,
          url: line.productUrl ?? prior?.url ?? null,
          bookingTransactionCode:
            prior?.bookingTransactionCode ??
            oldLump?.bookingTransactionCode ??
            null,
        },
        provenance,
      );
      keptExpenses.add(key);
      for (const share of input.attributions.filter(
        (row) => row.expenseId === prior?.id && !row.deletedAt,
      )) {
        const attributionKey = ownKeyFor(c, attributionRecords, share.id);
        if (attributionKey) {
          write(attributionRecords, attributionKey, {
            expenseId,
            role: share.role,
            ledgerPartyId: share.ledgerPartyId,
            weight: share.weight,
          });
          keptAttributions.add(attributionKey);
        }
      }
      for (const share of carriedAttributions.filter(
        (row) => !order.refund && row.lineIndex === line.lineIndex,
      )) {
        const attributionKey = `${key}:${share.role}:${share.partyCode}`;
        write(attributionRecords, attributionKey, {
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
        !input.attributions.some(
          (share) =>
            share.expenseId === prior?.id &&
            !share.deletedAt &&
            share.role === "beneficiary",
        ) &&
        !carriedAttributions.some((row) => row.role === "beneficiary")
      ) {
        const attributionKey = `${key}:beneficiary`;
        write(attributionRecords, attributionKey, {
          expenseId,
          role: "beneficiary",
          ledgerPartyId: owner,
          weight: 1,
        });
        keptAttributions.add(attributionKey);
      }
    }
  const payments = input.payments.filter((row) =>
    ownOrders.some((order) => paymentBelongsToOrder(row, order.observation)),
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
          paymentBelongsToOrder(row, other.observation) &&
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
      ? (ownOrders.find((row) =>
          paymentBelongsToOrder(payment, row.observation),
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
  for (const seed of manualAllocations) {
    const id = seed.values.transactionId;
    const transaction = input.transactions.find(
      (row) => row.id === id && !row.deletedAt,
    );
    const other = input.allocations.filter(
      (row) =>
        !row.deletedAt &&
        row.transactionId === id &&
        row.purchaseId !== purchaseId,
    );
    const own = manualAllocations
      .filter((row) => row.values.transactionId === id)
      .map((row) => ({
        purchaseId: String(row.values.purchaseId),
        amountMinor: BigInt(String(row.values.amountMinor)),
      }));
    if (
      !transaction ||
      allocationSetViolation({
        transactionAmountMinor: transaction.amount,
        kind: transaction.kind,
        next: [...other, ...own],
      })
    ) {
      c.disagree(
        "the recorded allocation split must conserve its bank movement",
      );
      return keep(c);
    }
  }
  if (
    input.allocations.some(
      (row) =>
        !row.deletedAt &&
        row.purchaseId === purchaseId &&
        !matched.has(row.transactionId) &&
        !manualAllocations.some(
          (seed) => seed.values.transactionId === row.transactionId,
        ),
    )
  ) {
    c.disagree("current payment evidence does not explain recorded settlement");
    return keep(c);
  }
  for (const [transactionId, amountMinor] of matched) {
    if (
      manualAllocations.some(
        (seed) => seed.values.transactionId === transactionId,
      )
    )
      continue;
    const transaction = input.transactions.find(
      (row) => row.id === transactionId,
    )!;
    const claims = sourceHeads.filter((other) =>
      input.payments.some(
        (row) =>
          paymentBelongsToOrder(row, other.observation) &&
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
      return keep(c);
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
    write(allocationRecords, key, {
      transactionId,
      purchaseId,
      amountMinor,
      confirmsMerchant: true,
    });
    keptAllocations.add(key);
  }
  for (const seed of seeds) {
    const kept =
      seed.target === expenseRecords
        ? keptExpenses
        : seed.target === allocationRecords
          ? keptAllocations
          : seed.target === attributionRecords
            ? keptAttributions
            : null;
    if (!kept || kept.has(seed.naturalKey)) continue;
    if (
      seed.target === expenseRecords &&
      oldLump &&
      c.recordId(expenseRecords, seed.naturalKey) === oldLump.id
    )
      continue;
    write(seed.target, seed.naturalKey, seed.values);
    kept.add(seed.naturalKey);
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
