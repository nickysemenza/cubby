import {
  financialSpendingAdvice,
  financialSpendingCostType,
} from "@cubby/schemas/financial-booking";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementMerchantIdentityInput,
  statementMerchantSupportInput,
  statementEscrowInput,
} from "@cubby/schemas/statement-answers";
import { minorToMoney } from "@cubby/shared";
import { sql } from "drizzle-orm";

import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { textArrayParam } from "~/server/db/helpers/array-param";
import {
  manualEntry,
  decision,
  answer,
  recordKey,
} from "~/server/db/kernel-schema";
import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
  purchase,
  purchasePaymentEvidence,
  sourceOccurrence,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import { financialAccountPurchaser } from "~/server/domains/financial-account/policy/purchaser";
import { allocationSetViolation } from "~/server/domains/financial-transaction/policy/allocation-set";
import { statementBookingRows } from "~/server/domains/financial-transaction/policy/booking-rows";
import {
  availableSpendingMinor,
  recordedSpendingOutcome,
  type CapacityRead,
} from "~/server/domains/financial-transaction/policy/recorded-spending";
import {
  blockingSpendingCandidates,
  decideSpendingCandidates,
  type CandidateSettlementFacts,
} from "~/server/domains/financial-transaction/policy/spending-candidates";
import { spendingCategoryForDiscovery } from "~/server/domains/financial-transaction/policy/spending-category";
import { spendingBlocker } from "~/server/domains/financial-transaction/policy/spending-prerequisites";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import {
  allocationRecords,
  attributionRecords,
  bookingVendors,
  expenseRecords,
  purchaseEventTables,
  purchaseRecords,
  restorePurchaseValues,
} from "~/server/domains/financial-transaction/repo/purchase-event-records";
import {
  bookingVendorCreations,
  bookingVendorSelection,
} from "~/server/domains/vendor/policy/booking-vendor";
import {
  bindingWrites,
  defineReconciler,
  recordSubject,
  source,
  type Binding,
  type ColumnRef,
  type Pure,
} from "~/server/kernel/api";
import { askEnvelope, inputHashOf } from "~/server/kernel/envelope";
import { decisionKey, answerKey } from "~/server/kernel/keys";

import type { purchaseAsks } from "../service/purchase-asks";
import {
  acceptedOccurrences,
  transactionAllocations,
  purchaseAllocations,
  purchaseExpenses,
  expenseAttributions,
  vendorPurchases,
  amountPayments,
  purchasePayments,
  vendorNames,
} from "./money-read-indexes";
import { partlyPaidPurchases } from "./purchase-candidate-index";

type Input = {
  key: string;
  bindings: Binding[];
  transactions: (typeof financialTransaction.$inferSelect)[];
  accounts: (typeof financialAccount.$inferSelect)[];
  parties: (typeof ledgerParty.$inferSelect)[];
  purchases: (typeof purchase.$inferSelect)[];
  expenses: (typeof expense.$inferSelect)[];
  allocations: (typeof financialTransactionAllocation.$inferSelect)[];
  attributions: (typeof expenseAttribution.$inferSelect)[];
  vendors: (typeof vendor.$inferSelect)[];
  categories: (typeof spendingCategory.$inferSelect)[];
  payments: (typeof purchasePaymentEvidence.$inferSelect)[];
  occurrences: (typeof sourceOccurrence.$inferSelect)[];
  /** The source occurrences behind each other charge that settles a loaded Purchase. */
  settlementOccurrences: {
    transactionId: string;
    occurrence: typeof sourceOccurrence.$inferSelect;
  }[];
  manuals: (typeof manualEntry.$inferSelect)[];
};
const targets = [
  purchaseRecords,
  expenseRecords,
  allocationRecords,
  attributionRecords,
  bookingVendors,
];
const tableReads = [
  source.table(financialTransaction, [
    "accountId",
    "kind",
    "status",
    "amount",
    "transactionDate",
    "postedDate",
    "merchant",
    "rawDescription",
    "spendingCategoryId",
    "itemizationExpectation",
    "ledgerTransferId",
    "deletedAt",
  ]),
  source.table(financialAccount, [
    "identity",
    "ledgerPartyId",
    "primaryCardholderId",
    "primaryCardholderMode",
    "authorizedUsers",
    "providerVendorId",
    "deletedAt",
  ]),
  source.table(ledgerParty, ["kind", "deletedAt"]),
  // SAFETY: the target declares columns of this exact table.
  source.table(
    purchase,
    purchaseRecords.columns as (keyof typeof purchase.$inferSelect)[],
    [vendorPurchases, partlyPaidPurchases],
  ),
  // SAFETY: the target declares columns of this exact table.
  source.table(
    expense,
    expenseRecords.columns as (keyof typeof expense.$inferSelect)[],
    [purchaseExpenses],
  ),
  source.table(
    financialTransactionAllocation,
    [
      "transactionId",
      "purchaseId",
      "amountMinor",
      "confirmsMerchant",
      "deletedAt",
    ],
    [transactionAllocations, purchaseAllocations],
  ),
  source.table(
    expenseAttribution,
    ["expenseId", "role", "ledgerPartyId", "weight", "deletedAt"],
    [expenseAttributions],
  ),
  source.table(
    vendor,
    [
      "name",
      "aliases",
      "defaultSpendingCategoryId",
      "itemizationExpectation",
      "orderEvidence",
      "deletedAt",
    ],
    [vendorNames],
  ),
  source.table(spendingCategory, ["deletedAt"]),
  source.table(
    purchasePaymentEvidence,
    ["purchaseId", "amountMinor", "chargedAt"],
    [amountPayments, purchasePayments],
  ),
  source.table(
    sourceOccurrence,
    [
      "acceptedTransactionId",
      "currentObservationId",
      "source",
      "identityKind",
      "identityScope",
      "providerIdentity",
      "physicalImportId",
      "physicalPosition",
      "disposition",
      "supersededByOccurrenceId",
      "deletedAt",
    ],
    [acceptedOccurrences],
  ),
  source.table(recordKey, ["scopeKind", "scopeKey", "entity", "entityId"]),
  source.table(entityIdentity, [
    "kind",
    "shortcode",
    "deletedAt",
    "mergedIntoId",
  ]),
  source.table(decision, ["subject", "channel", "kind", "value", "at"]),
  source.table(answer, ["inputHash", "output"]),
];
function retained(c: Pure) {
  for (const target of targets)
    for (const key of c.existing(target)) c.retire(target, key, "keep");
}
function record(
  c: Pure,
  target: ColumnRef,
  naturalKey: string,
  values: Parameters<Pure["record"]>[2],
  provenance: Record<string, string> = {},
) {
  const identity = c.identity(target, naturalKey);
  const desired = { ...values };
  for (const [field, decision] of c.assignments(
    recordSubject(target.entity ?? target.name, identity.id),
  )) {
    if (!target.columns.includes(field)) continue;
    Object.assign(
      desired,
      restorePurchaseValues({
        [field]: decision.kind === "none" ? null : decision.value,
      }),
    );
    provenance[field] = decision.id;
  }
  const references = {
    vendorId: "vendor",
    vendorAccountId: "vendorAccount",
    purchaserOverrideId: "ledgerParty",
    defaultProjectId: "project",
    projectId: "project",
    spendingCategoryId: "spendingCategory",
    productId: "product",
    purchaseId: "purchase",
    transactionId: "financialTransaction",
    expenseId: "expense",
    ledgerPartyId: "ledgerParty",
  } as const;
  for (const [field, entity] of Object.entries(references)) {
    const reference = desired[field];
    if (typeof reference === "string")
      desired[field] = c.reference(entity, reference);
  }
  return c.record(target, naturalKey, desired, { provenance });
}
/**
 * Member decisions on the booking itself hold it once its charge stops
 * supporting spending. `book` only permits a lump and holds nothing.
 */
function decidedBooking(c: Pure, subject: string) {
  return (
    [...c.assignments(subject).keys()].some((field) => field !== "book") ||
    targets.some((target) =>
      c.existing(target).some((key) => {
        const id = c.recordId(target, key);
        return (
          !!id &&
          c.assignments(recordSubject(target.entity ?? target.name, id)).size >
            0
        );
      }),
    )
  );
}
function ownKey(c: Pure, target: ColumnRef, fallback: string) {
  return c.existing(target)[0] ?? fallback;
}
function graph(input: Input, purchaseId: string): CapacityRead {
  return {
    lines: input.expenses
      .filter((row) => !row.deletedAt && row.purchaseId === purchaseId)
      .map((row) => ({ ...row, costMinor: row.cost })),
    settlements: input.allocations
      .filter((row) => !row.deletedAt && row.purchaseId === purchaseId)
      .flatMap((row) => {
        const transaction = input.transactions.find(
          (t) => t.id === row.transactionId,
        );
        if (!transaction) return [];
        const account = input.accounts.find(
          (a) => a.id === transaction.accountId,
        );
        return [
          {
            ...row,
            transactionCode: transaction.shortcode,
            transactionAmountMinor: transaction.amount,
            allocatedMinor: input.allocations
              .filter((a) => !a.deletedAt && a.transactionId === transaction.id)
              .reduce((sum, a) => sum + a.amountMinor, 0n),
            deleted: !!transaction.deletedAt,
            accountDeleted: !account || !!account.deletedAt,
            status: transaction.status,
            ledgerTransferId: transaction.ledgerTransferId,
            kind: transaction.kind,
          },
        ];
      }),
  };
}

/** One economic purchase event; a source charge is an event until an identity decision joins it. */
export function createPurchaseEvent({
  merchantIdentityAsk,
  merchantIdentityRequest,
  merchantAnswer,
  supportRequest,
  supportAnswer,
  escrowRequest,
  escrowAnswer,
  merchantSupportAsk,
  escrowAsk,
}: typeof purchaseAsks) {
  const purchaseEvent = defineReconciler<Input>({
    scope: "purchaseEvent",
    lane: "money",
    version: 1,
    after: ["bankEvent"],
    reads: [
      ...tableReads,
      source.evidence(manualTransactionEvidence),
      source.bindings,
    ],
    writes: [...targets, bindingWrites],
    asks: [merchantIdentityAsk, merchantSupportAsk, escrowAsk],
    async load(reads, keys) {
      const unique = <T extends { id: string }>(rows: T[]) => [
        ...new Map(rows.map((row) => [row.id, row])).values(),
      ];
      const transactions = [
        ...(await reads.rows(financialTransaction, keys)).values(),
      ];
      const subjects = keys.map((key) => `purchaseEvent:${key}`);
      const [
        manuals,
        choices,
        initialVendors,
        bankOwners,
        ownAllocationEntries,
      ] = await Promise.all([
        reads.facts(
          manualTransactionEvidence,
          keys.map((key) => `purchaseEvent:${key}`),
        ),
        reads.select(
          decision,
          subjects.map(decisionKey),
          sql`${decision.subject} = ANY(${textArrayParam(subjects)})`,
        ),
        reads.lookup(
          vendor,
          vendorNames,
          transactions.flatMap((row) =>
            [row.merchant, row.rawDescription]
              .filter((name): name is string => !!name)
              .map((name) => name.trim().toLowerCase()),
          ),
        ),
        reads.select(
          recordKey,
          keys.map((key) => `record:financialTransaction:${key}`),
          sql`${recordKey.scopeKind}='bankEvent' AND ${recordKey.entity}=${"financialTransaction"} AND ${recordKey.entityId}=ANY(${textArrayParam(keys)}::uuid[])`,
        ),
        Promise.all(
          keys.map(
            async (key) =>
              [
                key,
                await reads
                  .for(key)
                  .lookup(
                    financialTransactionAllocation,
                    transactionAllocations,
                    [key],
                  ),
              ] as const,
          ),
        ),
      ]);
      const strings = (value: unknown): string[] =>
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.flatMap(strings)
            : value && typeof value === "object"
              ? Object.values(value).flatMap(strings)
              : [];
      const references = choices.flatMap((row) => strings(row.value));
      const identities = references.length
        ? await reads.select(
            entityIdentity,
            subjects.map(decisionKey),
            sql`${entityIdentity.id}::text = ANY(${textArrayParam(references)}) OR ${entityIdentity.shortcode} = ANY(${textArrayParam(references)})`,
          )
        : [];
      let redirects = identities.flatMap((row) =>
        row.mergedIntoId ? [row.mergedIntoId] : [],
      );
      const visited = new Set(identities.map((row) => row.id));
      while (redirects.length) {
        const rows = await reads.rows(
          entityIdentity,
          redirects.filter((id) => !visited.has(id)),
        );
        for (const row of rows.values()) {
          identities.push(row);
          visited.add(row.id);
        }
        redirects = [...rows.values()].flatMap((row) =>
          row.mergedIntoId && !visited.has(row.mergedIntoId)
            ? [row.mergedIntoId]
            : [],
        );
      }
      const referenceIds = (kind: string) =>
        identities
          .filter(
            (row) => row.kind === kind && !row.deletedAt && !row.mergedIntoId,
          )
          .map((row) => row.id);
      const hashes = await Promise.all(
        transactions.map((row) =>
          inputHashOf(
            askEnvelope(
              merchantIdentityAsk,
              merchantIdentityRequest(
                statementMerchantIdentityInput({
                  ...row,
                  amount: minorToMoney(row.amount),
                }) ?? { merchant: "" },
              ),
            ),
          ),
        ),
      );
      const saved = await reads.select(
        answer,
        hashes.map(answerKey),
        sql`${answer.inputHash} = ANY(${textArrayParam(hashes)})`,
      );
      const names = saved.flatMap((row) => {
        const name = merchantAnswer(row.output)?.name;
        return name ? [name.trim().toLowerCase()] : [];
      });
      for (const row of choices)
        if (row.field === "vendorName" && typeof row.value === "string")
          names.push(row.value.trim().toLowerCase());
      const namedVendors = await reads.lookup(vendor, vendorNames, names);
      const seeded = [...manuals.values()].flat().flatMap((row) => {
        const parsed = row.payload;
        return parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof parsed.table === "string" &&
          parsed.values &&
          typeof parsed.values === "object" &&
          !Array.isArray(parsed.values)
          ? [{ id: row.id, table: parsed.table, values: parsed.values }]
          : [];
      });
      const ownAllocationsByScope = new Map(ownAllocationEntries);
      const retainedPurchases = await reads.rows(
        purchase,
        [...ownAllocationsByScope.values()].flat().map((row) => row.purchaseId),
      );
      const retainedVendors = await reads.rows(
        vendor,
        [...retainedPurchases.values()].flatMap((row) =>
          row.vendorId ? [row.vendorId] : [],
        ),
      );
      const vendors = unique([
        ...initialVendors,
        ...namedVendors,
        ...retainedVendors.values(),
        ...(await reads.rows(vendor, referenceIds("vendor"))).values(),
      ]);
      const inputs = await Promise.all(
        keys.map(async (key): Promise<readonly [string, Input]> => {
          const scoped = reads.for(key);
          const transaction = transactions.find((row) => row.id === key);
          const ownSeeds = seeded.filter((row) =>
            (manuals.get(`purchaseEvent:${key}`) ?? []).some(
              (manual) => manual.id === row.id,
            ),
          );
          const ownIds = (table: string) =>
            ownSeeds.filter((row) => row.table === table).map((row) => row.id);
          const currentAllocations = ownAllocationsByScope.get(key) ?? [];
          const currentChoices = choices.filter(
            (row) => row.subject === `purchaseEvent:${key}`,
          );
          const matchedAnswer = saved.find(
            (row) =>
              row.inputHash ===
              hashes[transactions.findIndex((row) => row.id === key)],
          );
          const answerName =
            merchantAnswer(matchedAnswer?.output)?.name ?? null;
          const names = new Set(
            [
              transaction?.merchant?.trim() ||
                transaction?.rawDescription?.trim(),
              answerName,
              ...currentChoices
                .filter(
                  (row) =>
                    row.field === "vendorName" && typeof row.value === "string",
                )
                .map((row) => String(row.value)),
            ]
              .filter((name): name is string => !!name)
              .map((name) => name.trim().toLowerCase()),
          );
          const retainedIds = new Set(
            currentAllocations.flatMap((row) => {
              const purchase = retainedPurchases.get(row.purchaseId);
              return purchase?.vendorId ? [purchase.vendorId] : [];
            }),
          );
          const selected = new Set(
            currentChoices
              .filter((row) => row.field === "vendorId")
              .flatMap((row) =>
                typeof row.value === "string" ? [row.value] : [],
              ),
          );
          const relevantVendors = vendors.filter(
            (row) =>
              retainedIds.has(row.id) ||
              selected.has(row.id) ||
              selected.has(row.shortcode) ||
              [row.name, ...row.aliases].some((name) =>
                names.has(name.trim().toLowerCase()),
              ),
          );
          const [
            ownAllocations,
            candidatePurchases,
            openPurchases,
            exactPayments,
            ownedPurchases,
            bindings,
            occurrences,
            accounts,
          ] = await Promise.all([
            Promise.resolve(currentAllocations),
            scoped.lookup(
              purchase,
              vendorPurchases,
              relevantVendors.flatMap((row) =>
                transaction &&
                (transaction.transactionDate ?? transaction.postedDate)
                  ? Array.from(
                      { length: 29 },
                      (_, index) =>
                        `${row.id}:${shiftPlainDate((transaction.transactionDate ?? transaction.postedDate)!, index - 14)}`,
                    )
                  : [],
              ),
            ),
            scoped.lookup(
              purchase,
              partlyPaidPurchases,
              transaction?.kind === "refund"
                ? []
                : relevantVendors.map((row) => row.id),
            ),
            scoped.lookup(
              purchasePaymentEvidence,
              amountPayments,
              transaction ? [String(transaction.amount)] : [],
            ),
            scoped.rows(purchase, [
              key,
              ...ownIds("Purchase"),
              ...referenceIds("purchase"),
            ]),
            scoped.bindings({
              events: [key],
              facts: ownSeeds.map((row) => ({
                kind: "manualEntry",
                id: row.id,
              })),
            }),
            scoped.rows(
              sourceOccurrence,
              bankOwners
                .filter(
                  (owner) =>
                    owner.entityId === key &&
                    !owner.scopeKey.startsWith("manual:"),
                )
                .map((owner) => owner.scopeKey),
            ),
            scoped.rows(
              financialAccount,
              transaction ? [transaction.accountId] : [],
            ),
          ]);
          const purchaseIds = [
            ...new Set([
              ...candidatePurchases.map((row) => row.id),
              ...openPurchases.map((row) => row.id),
              ...ownedPurchases.keys(),
              ...exactPayments.map((row) => row.purchaseId),
              ...ownAllocations.map((row) => row.purchaseId),
            ]),
          ];
          const [purchases, expenses, allocations, payments] =
            await Promise.all([
              scoped.rows(purchase, purchaseIds),
              scoped.lookup(expense, purchaseExpenses, purchaseIds),
              scoped.lookup(
                financialTransactionAllocation,
                purchaseAllocations,
                purchaseIds,
              ),
              scoped.lookup(
                purchasePaymentEvidence,
                purchasePayments,
                purchaseIds,
              ),
            ]);
          const [settlementTransactions, attributions, settlementAllocations] =
            await Promise.all([
              scoped.rows(
                financialTransaction,
                allocations.map((row) => row.transactionId),
              ),
              scoped.lookup(
                expenseAttribution,
                expenseAttributions,
                expenses.map((row) => row.id),
              ),
              scoped.lookup(
                financialTransactionAllocation,
                transactionAllocations,
                [...new Set(allocations.map((row) => row.transactionId))],
              ),
            ]);
          const allTransactions = unique([
            ...transactions.filter((row) => row.id === key),
            ...settlementTransactions.values(),
          ]);
          const moreAccounts = await scoped.rows(
            financialAccount,
            allTransactions.map((row) => row.accountId),
          );
          const allAccounts = unique([
            ...accounts.values(),
            ...moreAccounts.values(),
          ]);
          const allVendors = unique([
            ...vendors,
            ...(
              await scoped.rows(
                vendor,
                purchases.size
                  ? [...purchases.values()].flatMap((row) =>
                      row.vendorId ? [row.vendorId] : [],
                    )
                  : [],
              )
            ).values(),
          ]);
          const [parties, categories] = await Promise.all([
            scoped.rows(ledgerParty, [
              ...referenceIds("ledgerParty"),
              ...allAccounts.flatMap((row) =>
                [row.ledgerPartyId, row.primaryCardholderId].filter(
                  (id): id is NonNullable<typeof id> => !!id,
                ),
              ),
              ...attributions.flatMap((row) =>
                row.ledgerPartyId ? [row.ledgerPartyId] : [],
              ),
            ]),
            scoped.rows(spendingCategory, [
              ...referenceIds("spendingCategory"),
              ...allTransactions.flatMap((row) =>
                row.spendingCategoryId ? [row.spendingCategoryId] : [],
              ),
              ...allVendors.flatMap((row) =>
                row.defaultSpendingCategoryId
                  ? [row.defaultSpendingCategoryId]
                  : [],
              ),
            ]),
          ]);
          return [
            key,
            {
              key,
              transactions: allTransactions,
              accounts: allAccounts,
              parties: [...parties.values()],
              purchases: [...purchases.values()],
              expenses,
              allocations: unique([
                ...ownAllocations,
                ...allocations,
                ...settlementAllocations,
              ]),
              attributions,
              vendors: allVendors,
              categories: [...categories.values()],
              payments,
              occurrences: [...occurrences.values()],
              bindings: bindings.filter(
                (binding) =>
                  binding.scope.kind === "purchaseEvent" &&
                  binding.scope.key === key,
              ),
              settlementOccurrences: [],
              manuals: manuals.get(`purchaseEvent:${key}`) ?? [],
            } satisfies Input,
          ] as const;
        }),
      );
      // Settlement proof reads the occurrences behind every other charge that
      // settles a loaded Purchase, once for the batch.
      const settling = [
        ...new Set(
          inputs.flatMap(([key, input]) =>
            input.allocations
              .filter((row) => !row.deletedAt && row.transactionId !== key)
              .map((row) => row.transactionId),
          ),
        ),
      ];
      const [settlingOwners, settlingAccepted] = settling.length
        ? await Promise.all([
            reads.select(
              recordKey,
              settling.map((id) => `record:financialTransaction:${id}`),
              sql`${recordKey.scopeKind}='bankEvent' AND ${recordKey.entity}=${"financialTransaction"} AND ${recordKey.entityId}=ANY(${textArrayParam(settling)}::uuid[])`,
            ),
            reads.lookup(sourceOccurrence, acceptedOccurrences, settling),
          ])
        : [[], []];
      const ownedOccurrences = await reads.rows(
        sourceOccurrence,
        settlingOwners
          .filter((row) => !row.scopeKey.startsWith("manual:"))
          .map((row) => row.scopeKey),
      );
      const settlementOccurrences = [
        ...settlingOwners.flatMap((row) => {
          const occurrence = ownedOccurrences.get(row.scopeKey);
          return occurrence
            ? [{ transactionId: row.entityId, occurrence }]
            : [];
        }),
        ...settlingAccepted.flatMap((occurrence) =>
          occurrence.acceptedTransactionId
            ? [{ transactionId: occurrence.acceptedTransactionId, occurrence }]
            : [],
        ),
      ];
      return new Map(
        inputs.map(([key, input]) => [
          key,
          {
            ...input,
            settlementOccurrences: settlementOccurrences.filter((entry) =>
              input.allocations.some(
                (row) => row.transactionId === entry.transactionId,
              ),
            ),
          },
        ]),
      );
    },
    // oxlint-disable-next-line complexity -- prerequisite, identity and conservation refusals form one atomic money plan.
    reconcile(input, c) {
      const subject = `purchaseEvent:${input.key}`;
      if (c.decision("rejection", subject)?.kind === "reject") {
        retained(c);
        return c.done();
      }
      // Manual entries and the later order-evidence writer's reviewed record decisions
      // use the same ownership and precedence as statement-derived records.
      let seeds: {
        target: ColumnRef;
        naturalKey: string;
        values: Parameters<Pure["record"]>[2];
        fact?: string;
        decision?: string;
      }[] = [];
      for (const entry of input.manuals) {
        const data = entry.payload;
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          typeof data.table !== "string" ||
          typeof data.naturalKey !== "string" ||
          !data.values ||
          typeof data.values !== "object" ||
          Array.isArray(data.values)
        )
          continue;
        const target = Object.values(purchaseEventTables).find(
          (item) => item.target.name === data.table,
        )?.target;
        if (target)
          seeds.push({
            target,
            naturalKey: data.naturalKey,
            values: restorePurchaseValues(data.values),
            fact: entry.id,
          });
      }
      for (const [field, decision] of c.assignments(subject)) {
        if (!field.startsWith("record:") || decision.kind !== "set") continue;
        const data = decision.value;
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          typeof data.table !== "string" ||
          typeof data.naturalKey !== "string" ||
          !data.values ||
          typeof data.values !== "object" ||
          Array.isArray(data.values)
        )
          continue;
        const target = Object.values(purchaseEventTables).find(
          (item) => item.target.name === data.table,
        )?.target;
        if (target)
          seeds.push({
            target,
            naturalKey: data.naturalKey,
            values: restorePurchaseValues(data.values),
            decision: decision.id,
          });
      }
      const combined = new Map<string, (typeof seeds)[number]>();
      for (const seed of seeds) {
        const key = `${seed.target.name}:${seed.naturalKey}`;
        combined.set(key, { ...combined.get(key), ...seed });
      }
      seeds = [...combined.values()];
      if (seeds.length) {
        const acceptedTransaction = input.transactions.find(
          (row) => row.id === input.key && !row.deletedAt,
        );
        const aggregateSeeds = seeds.filter(
          (seed) =>
            seed.target === expenseRecords &&
            seed.values.lineBasis === "allocation" &&
            seed.values.economicRole !== "reimbursement",
        );
        const slices = input.allocations.filter(
          (row) => !row.deletedAt && row.transactionId === input.key,
        );
        for (const seed of seeds) {
          const id = c.identity(seed.target, seed.naturalKey).id;
          for (const [field, decision] of c.assignments(
            recordSubject(seed.target.entity ?? seed.target.name, id),
          )) {
            if (seed.target.columns.includes(field))
              Object.assign(
                seed.values,
                restorePurchaseValues({
                  [field]: decision.kind === "none" ? null : decision.value,
                }),
              );
          }
        }
        const projectedAmount = (slice: Input["allocations"][number]) => {
          const seed = seeds.find(
            (seed) =>
              seed.target === allocationRecords &&
              c.recordId(allocationRecords, seed.naturalKey) === slice.id,
          );
          return seed && typeof seed.values.amountMinor === "bigint"
            ? seed.values.amountMinor
            : slice.amountMinor;
        };
        const projectedSlices = slices.map(projectedAmount);
        const purchaseTotal =
          aggregateSeeds.length === 1
            ? input.allocations
                .filter(
                  (row) =>
                    !row.deletedAt &&
                    row.purchaseId === aggregateSeeds[0]!.values.purchaseId &&
                    input.transactions.some(
                      (transaction) =>
                        transaction.id === row.transactionId &&
                        !transaction.deletedAt,
                    ),
                )
                .reduce((sum, row) => sum + projectedAmount(row), 0n)
            : null;
        if (
          acceptedTransaction &&
          slices.length &&
          (projectedSlices.reduce((sum, value) => sum + value, 0n) !==
            acceptedTransaction.amount ||
            (aggregateSeeds.length === 1 &&
              aggregateSeeds[0]!.values.cost !== purchaseTotal))
        ) {
          c.disagree(
            "the recorded spending and allocation slices disagree with the statement movement",
          );
        }
        for (const seed of seeds) c.identity(seed.target, seed.naturalKey);
        const seeded = new Set<string>();
        for (const seed of seeds) {
          const key = `${seed.target.name}:${seed.naturalKey}`;
          seeded.add(key);
          const provenance = seed.decision
            ? Object.fromEntries(
                Object.keys(seed.values).map((field) => [
                  field,
                  seed.decision!,
                ]),
              )
            : {};
          const id = record(
            c,
            seed.target,
            seed.naturalKey,
            seed.values,
            provenance,
          );
          if (seed.fact) c.bind({ kind: "manualEntry", id: seed.fact }, id);
        }
        for (const target of targets)
          for (const key of c.existing(target))
            if (!seeded.has(`${target.name}:${key}`))
              c.retire(target, key, "keep");
        return c.done();
      }
      const transaction = input.transactions.find(
        (row) => row.id === input.key && !row.deletedAt,
      );
      if (
        !transaction ||
        !["purchase", "fee", "refund"].includes(transaction.kind) ||
        ["void", "expected"].includes(transaction.status) ||
        transaction.ledgerTransferId
      ) {
        // A removed, voided or reclassified charge supports no spending. Its
        // generated booking goes unless a member decision holds it; a merged
        // charge's booking now settles the survivor.
        const stored = input.transactions.find((row) => row.id === input.key);
        const survivor = stored
          ? c.reference("financialTransaction", input.key)
          : null;
        if (
          !stored ||
          (survivor !== null && survivor !== input.key) ||
          !targets.some((target) => c.existing(target).length)
        ) {
          retained(c);
          return c.done();
        }
        if (decidedBooking(c, subject)) {
          c.gap.unsupported(
            "the charge no longer supports this spending, and the booking carries member decisions",
          );
          retained(c);
          return c.done();
        }
        for (const target of targets)
          for (const key of c.existing(target))
            c.retire(
              target,
              key,
              target === bookingVendors ? "keep" : "remove",
            );
        return c.done();
      }
      const chosen = (field: string) =>
        c.decision("assignment", subject, field);
      const value = (field: string) => chosen(field)?.value;
      const existingPurchaseKey = c.existing(purchaseRecords)[0];
      const existingPurchaseId = existingPurchaseKey
        ? c.recordId(purchaseRecords, existingPurchaseKey)
        : null;
      const existingPurchase = input.purchases.find(
        (row) => row.id === existingPurchaseId,
      );
      const recorded = input.allocations.filter(
        (row) => !row.deletedAt && row.transactionId === transaction.id,
      );
      const ownAllocations = new Set(
        c
          .existing(allocationRecords)
          .map((key) => c.recordId(allocationRecords, key)),
      );
      const prior = recordedSpendingOutcome({
        amountMinor: transaction.amount,
        beneficiariesSpecified: false,
        lineageMatches: true,
        allocations: recorded,
        purchases: recorded.map((allocation) => {
          const row = input.purchases.find(
            (p) => p.id === allocation.purchaseId && !p.deletedAt,
          );
          return {
            id: allocation.purchaseId,
            shortcode: row?.shortcode ?? "",
            availableMinor: availableSpendingMinor(
              graph(input, allocation.purchaseId),
              transaction.amount,
              transaction.id,
            ),
          };
        }),
      });
      if (
        recorded.length &&
        !recorded.every((row) => ownAllocations.has(row.id))
      ) {
        if (prior?.kind === "review") c.gap.decision(prior.reason);
        retained(c);
        return c.done();
      }
      const account = input.accounts.find(
        (row) => row.id === transaction.accountId && !row.deletedAt,
      );
      if (!account) {
        c.gap.decision("a live financial account");
        retained(c);
        return c.done();
      }
      const accountParty =
        input.parties.find((row) => row.id === account.ledgerPartyId) ?? null;
      const spendingDate =
        transaction.transactionDate ?? transaction.postedDate;
      const primaryId =
        account.primaryCardholderId ??
        (account.primaryCardholderMode === "inherit" &&
        accountParty?.kind === "member"
          ? accountParty.id
          : null);
      const primaryCardholder =
        input.parties.find((row) => row.id === primaryId) ?? null;
      const soleAccess =
        !!spendingDate &&
        !account.authorizedUsers.some(
          (period) =>
            (!period.validFrom || period.validFrom <= spendingDate) &&
            (!period.validTo || period.validTo >= spendingDate),
        );
      const purchaser = financialAccountPurchaser(
        { ...account, ledgerParty: accountParty },
        { soleAccess, primaryCardholder },
      );
      const purchaserChoice =
        typeof value("purchaserId") === "string"
          ? c.reference("ledgerParty", String(value("purchaserId")))
          : (purchaser?.id ?? null);
      const merchant =
        transaction.merchant?.trim() ||
        transaction.rawDescription?.trim() ||
        "";
      const reviewedName =
        typeof value("vendorName") === "string"
          ? String(value("vendorName")).trim()
          : null;
      const spendingSubject = {
        ...transaction,
        amount: minorToMoney(transaction.amount),
      };
      const rawVendors = input.vendors.filter(
        (row) =>
          !row.deletedAt &&
          [row.name, ...row.aliases].some(
            (alias) => alias.trim().toLowerCase() === merchant.toLowerCase(),
          ),
      );
      const identityInput = rawVendors.length
        ? null
        : statementMerchantIdentityInput(spendingSubject);
      const identityAnswer = identityInput
        ? c.answer(merchantIdentityAsk, merchantIdentityRequest(identityInput))
        : null;
      const identity =
        identityAnswer?.status === "answered"
          ? merchantAnswer(identityAnswer.output)
          : null;
      const supportInput =
        identity && identityInput
          ? statementMerchantSupportInput(identityInput, identity)
          : null;
      const support = supportInput
        ? c.answer(merchantSupportAsk, supportRequest(supportInput))
        : null;
      const escrowInput = statementEscrowInput(
        spendingSubject,
        account.identity.kind === "loan",
      );
      const escrow = escrowInput
        ? c.answer(escrowAsk, escrowRequest(escrowInput))
        : null;
      const storedAdvice = {
        vendorName: identity?.name ?? null,
        vendorConfidence:
          support?.status === "answered" && supportAnswer(support.output)
            ? identity?.confidence
            : "low",
        counterparty: identity?.counterparty ?? "unknown",
        ...(escrow?.status === "answered"
          ? { escrowDisbursement: escrowAnswer(escrow.output) }
          : {}),
      };
      const adviceResult = financialSpendingAdvice.safeParse(
        value("advice") ?? storedAdvice,
      );
      const advice = adviceResult.success ? adviceResult.data : null;
      const cleanName = reviewedName ?? advice?.vendorName ?? merchant;
      const resolve = (name: string) => {
        const candidates = input.vendors.filter(
          (row) =>
            !row.deletedAt &&
            [row.name, ...row.aliases].some(
              (alias) =>
                alias.trim().toLowerCase() === name.trim().toLowerCase(),
            ),
        );
        return {
          row: candidates.length === 1 ? candidates[0] : null,
          candidates: candidates.length > 1 ? candidates : [],
        };
      };
      const checked = [[resolve(merchant), resolve(cleanName)]];
      const selectedId =
        typeof value("vendorId") === "string"
          ? c.reference("vendor", String(value("vendorId")))
          : (existingPurchase?.vendorId ?? null);
      const selected = input.vendors.find(
        (row) => row.id === selectedId && !row.deletedAt,
      );
      const resolvedVendor =
        selected ?? checked[0]!.find((result) => result.row)?.row ?? null;
      const sources = input.occurrences.filter((row) => !row.deletedAt);
      const blocker = spendingBlocker({
        facts: {
          source: {
            accountId: parseShortcodeFor("financialAccount", account.shortcode),
            kind: transaction.kind,
            status: transaction.status,
            amountMinor: transaction.amount,
            transactionDate: transaction.transactionDate,
            postedDate: transaction.postedDate,
            merchant: transaction.merchant,
            rawDescription: transaction.rawDescription,
            sourceRefs: sources.length
              ? sources.map((row) => ({
                  source: row.source,
                  externalId: row.shortcode,
                }))
              : [{ source: "manual", externalId: transaction.shortcode }],
          },
          account: { ...account, ledgerParty: accountParty },
          purchaser: purchaserChoice
            ? (input.parties.find(
                (row) => row.id === purchaserChoice && !row.deletedAt,
              ) ?? null)
            : null,
        },
        advice: reviewedName
          ? {
              ...(advice ?? financialSpendingAdvice.parse({})),
              vendorName: reviewedName,
              vendorConfidence: "high",
              counterparty: "business",
            }
          : advice,
        vendorResolved: !!resolvedVendor,
        ambiguous:
          !selected &&
          checked[0]!.some((result) => result.candidates.length > 0),
      });
      if (blocker) {
        c.gap.decision(blocker, {
          actions: input.vendors
            .filter((row) => !row.deletedAt)
            .map((row) => ({
              channel: "assignment",
              kind: "set",
              subject,
              field: "vendorId",
              value: row.shortcode,
              label: `Use ${row.name}`,
            })),
        });
        retained(c);
        return c.done();
      }
      const bookings = [
        {
          vendorId: resolvedVendor?.shortcode ?? null,
          selectedCode: selected?.shortcode,
          name: cleanName,
          merchant,
        },
      ];
      const creations = bookingVendorCreations(bookings, checked);
      if (creations.kind !== "ready") {
        c.gap.decision(creations.reason);
        retained(c);
        return c.done();
      }
      const vendorNaturalKey = ownKey(
        c,
        bookingVendors,
        `vendor:${cleanName.toLowerCase()}`,
      );
      const vendorIdentity = c.identity(bookingVendors, vendorNaturalKey);
      const minted = {
        id: vendorIdentity.id,
        shortcode: vendorIdentity.shortcode!,
      };
      const selection = bookingVendorSelection(
        bookings,
        checked,
        selected ? [selected] : [],
        new Map([[0, { row: minted, candidates: [] }]]),
      );
      if (selection.kind !== "ready") {
        c.gap.decision(selection.reason);
        retained(c);
        return c.done();
      }
      const vendorRow = selection.rows[0]!;
      const date = transaction.transactionDate ?? transaction.postedDate!;
      const candidates = decideSpendingCandidates(
        {
          date,
          amountMinor: transaction.amount,
          refund: transaction.kind === "refund",
          vendorId: vendorRow.id,
        },
        input.purchases
          .filter((row) => !row.deletedAt && row.id !== existingPurchaseId)
          .map((row) => {
            const capacity = graph(input, row.id);
            return {
              ...row,
              expenses: capacity.lines
                .filter(
                  (line) => !line.future && line.economicRole === "vendor",
                )
                .map((line) => ({
                  costMinor: line.costMinor,
                  lineKind: line.lineKind,
                })),
              payments: input.payments
                .filter((payment) => payment.purchaseId === row.id)
                .map((payment) => ({
                  amountMinor: payment.amountMinor,
                  chargedDate: payment.chargedAt
                    ? householdLocalDate(payment.chargedAt)
                    : null,
                })),
              settlements: capacity.settlements.map((settlement) => ({
                ...settlement,
                transactionDeleted: settlement.deleted,
                reimbursement: input.expenses.some(
                  (line) =>
                    !line.deletedAt &&
                    line.purchaseId === row.id &&
                    line.economicRole === "reimbursement",
                ),
              })),
            };
          }),
      );
      const identitySubject = recordSubject(
        "financialTransaction",
        transaction.id,
      );
      const abs = (value: bigint) => (value < 0n ? -value : value);
      const live = (row: (typeof input.occurrences)[number]) =>
        !row.deletedAt &&
        !row.supersededByOccurrenceId &&
        row.disposition !== "ignored";
      // Another provider ID in the same provider scope, or another position in
      // the same collection, proves a different bank event of this source.
      const otherEvent = (transactionId: string) => {
        const settled = input.transactions.find(
          (row) => row.id === transactionId,
        );
        if (
          transaction.status === "posted" &&
          settled?.status === "posted" &&
          abs(settled.amount) !== abs(transaction.amount)
        )
          return true;
        return input.settlementOccurrences.some(
          ({ transactionId: id, occurrence: other }) =>
            id === transactionId &&
            live(other) &&
            sources.some(
              (own) =>
                own.id !== other.id &&
                own.source === other.source &&
                ((own.identityKind === "provider" &&
                  other.identityKind === "provider" &&
                  own.identityScope === other.identityScope &&
                  own.providerIdentity !== other.providerIdentity) ||
                  (own.identityKind === "positioned" &&
                    other.identityKind === "positioned" &&
                    own.physicalImportId === other.physicalImportId &&
                    own.physicalPosition !== other.physicalPosition)),
            ),
        );
      };
      const facts = new Map<string, CandidateSettlementFacts>(
        candidates.map((candidate) => {
          const capacity = graph(input, candidate.id);
          const reimbursements = new Set(
            capacity.lines
              .filter((line) => line.economicRole === "reimbursement")
              .map((line) => line.bookingTransactionCode),
          );
          return [
            candidate.id,
            {
              availableMinor: availableSpendingMinor(
                capacity,
                transaction.amount,
                transaction.id,
              ),
              paymentsMinor: input.payments
                .filter((payment) => payment.purchaseId === candidate.id)
                .map((payment) => payment.amountMinor),
              otherSettlements: capacity.settlements
                .filter(
                  (settlement) =>
                    settlement.transactionId !== transaction.id &&
                    settlement.kind !== "income" &&
                    !reimbursements.has(settlement.transactionCode) &&
                    settlement.amountMinor < 0n === transaction.amount < 0n,
                )
                .map((settlement) => ({
                  distinctEvent: otherEvent(settlement.transactionId),
                })),
              decided: !!c.decision(
                "identity",
                identitySubject,
                recordSubject("purchase", candidate.id),
              ),
            },
          ] as const;
        }),
      );
      const blocking = blockingSpendingCandidates(
        {
          amountMinor: transaction.amount,
          refund: transaction.kind === "refund",
        },
        candidates,
        facts,
      );
      const same = blocking.filter(
        (candidate) =>
          c.decision(
            "identity",
            identitySubject,
            recordSubject("purchase", candidate.id),
          )?.kind === "same",
      );
      const unresolved = blocking.filter(
        (candidate) =>
          c.decision(
            "identity",
            identitySubject,
            recordSubject("purchase", candidate.id),
          )?.kind !== "distinct",
      );
      const explicitPurchase =
        typeof value("purchaseId") === "string"
          ? c.reference("purchase", String(value("purchaseId")))
          : null;
      const targetPurchase =
        explicitPurchase ?? (same.length === 1 ? same[0]!.id : null);
      if (
        same.length > 1 ||
        (!targetPurchase && unresolved.length && value("purchaseId") !== null)
      ) {
        c.gap.decision(
          "whether this charge and the candidate Purchase are the same or distinct",
          {
            actions: unresolved.flatMap((candidate) => [
              {
                channel: "identity",
                kind: "same",
                subject: identitySubject,
                field: recordSubject("purchase", candidate.id),
                label: `Same Purchase: ${candidate.shortcode}`,
              },
              {
                channel: "identity",
                kind: "distinct",
                subject: identitySubject,
                field: recordSubject("purchase", candidate.id),
                label: `Distinct Purchase: ${candidate.shortcode}`,
              },
            ]),
          },
        );
        retained(c);
        return c.done();
      }
      const existingTarget = input.purchases.find(
        (row) =>
          row.id === targetPurchase &&
          row.id !== existingPurchaseId &&
          !row.deletedAt,
      );
      const resolved = input.vendors.find((row) => row.id === vendorRow.id);
      const waiting =
        transaction.itemizationExpectation ??
        existingTarget?.itemizationExpectation ??
        resolved?.itemizationExpectation;
      if (!existingTarget && waiting === "required" && value("book") !== true) {
        c.gap.evidence("waiting for order details", "you", {
          actions: [
            {
              channel: "assignment",
              kind: "set",
              subject,
              field: "book",
              value: true,
              label: "Book a lump Expense",
            },
          ],
        });
        retained(c);
        return c.done();
      }
      const selectedCategory =
        typeof value("spendingCategoryId") === "string"
          ? c.reference("spendingCategory", String(value("spendingCategoryId")))
          : (transaction.spendingCategoryId ??
            resolved?.defaultSpendingCategoryId ??
            null);
      const category = selectedCategory
        ? spendingCategoryForDiscovery(input.categories, {
            id: selectedCategory,
          })
        : undefined;
      if (selectedCategory && !category) {
        c.gap.decision("a live spending category");
        retained(c);
        return c.done();
      }
      // A charge joins an existing Purchase only where its lines leave room
      // for it; a lump beside priced or unpriced lines counts spending twice.
      const targetGraph = existingTarget
        ? graph(input, existingTarget.id)
        : undefined;
      const targetLines = (targetGraph?.lines ?? []).filter(
        (line) => !line.future && line.economicRole === "vendor",
      );
      const remaining = targetLines.length
        ? availableSpendingMinor(
            targetGraph,
            transaction.amount,
            transaction.id,
          )
        : 0n;
      const directional = targetLines.some(
        (line) =>
          line.costMinor !== null &&
          (transaction.amount < 0n
            ? line.costMinor < 0n && line.lineKind === "principal"
            : line.costMinor >= 0n || line.lineKind !== "principal"),
      );
      if (
        remaining === null ||
        (directional &&
          (transaction.amount < 0n
            ? remaining > transaction.amount
            : remaining < transaction.amount))
      ) {
        c.gap.decision(
          remaining === null
            ? "the chosen Purchase has an unpriced or unclassified line or an uncertain payment, so its remaining capacity for this charge is unknown"
            : "the chosen Purchase's remaining capacity cannot cover this charge",
        );
        retained(c);
        return c.done();
      }
      // Moving the charge retires the Purchase this scope created for it, which
      // must not hold anyone else's spending.
      const ownRecords = new Set(
        targets.flatMap((target) =>
          c.existing(target).map((key) => c.recordId(target, key)),
        ),
      );
      if (
        existingTarget &&
        existingPurchaseId &&
        (input.expenses.some(
          (row) =>
            !row.deletedAt &&
            row.purchaseId === existingPurchaseId &&
            !ownRecords.has(row.id),
        ) ||
          input.allocations.some(
            (row) =>
              !row.deletedAt &&
              row.purchaseId === existingPurchaseId &&
              row.transactionId !== transaction.id,
          ))
      ) {
        c.gap.decision(
          "the Purchase this charge booked holds other spending; reconcile it before moving the charge",
        );
        retained(c);
        return c.done();
      }
      const rows = statementBookingRows({
        charge: {
          transactionId: parseShortcodeFor(
            "financialTransaction",
            transaction.shortcode,
          ),
          amountMinor: transaction.amount,
          date,
          name: merchant,
        },
        purchaseId: existingTarget
          ? parseShortcodeFor("purchase", existingTarget.shortcode)
          : null,
        purchaserId: purchaserChoice
          ? parseShortcodeFor(
              "ledgerParty",
              input.parties.find((row) => row.id === purchaserChoice)!
                .shortcode,
            )
          : null,
        vendorId: parseShortcodeFor("vendor", vendorRow.shortcode),
        categoryOverride: category
          ? parseShortcodeFor("spendingCategory", category.shortcode)
          : null,
        economicRole: "vendor",
        costType: financialSpendingCostType(
          transaction.kind,
          value("costType") === "services"
            ? "services"
            : value("costType") === "tools"
              ? "tools"
              : undefined,
        ),
        trade: "other",
        beneficiaries: undefined,
        confirmsMerchant: value("confirmsMerchant") === true,
        remainingBookedMinor: directional ? remaining : 0n,
      });
      const purchaseKey = ownKey(c, purchaseRecords, "purchase");
      const purchaseId =
        existingTarget?.id ?? c.identity(purchaseRecords, purchaseKey).id;
      const violation = allocationSetViolation({
        transactionAmountMinor: transaction.amount,
        kind: transaction.kind,
        next: [{ purchaseId, amountMinor: rows.allocation.amountMinor }],
      });
      if (violation) {
        c.gap.decision(violation);
        retained(c);
        return c.done();
      }
      const declared = new Set<string>();
      const book = (
        target: ColumnRef,
        naturalKey: string,
        values: Parameters<Pure["record"]>[2],
      ) => {
        declared.add(`${target.name}:${naturalKey}`);
        return record(c, target, naturalKey, values);
      };
      if (!resolvedVendor)
        book(bookingVendors, vendorNaturalKey, {
          name: cleanName,
          aliases: merchant && merchant !== cleanName ? [merchant] : [],
        });
      if (rows.purchase)
        book(purchaseRecords, purchaseKey, {
          ...rows.purchase,
          vendorId: vendorRow.id,
          purchaserOverrideId: purchaserChoice,
        });
      if (rows.expense) {
        const expenseKey = ownKey(c, expenseRecords, "expense");
        const expenseId = book(expenseRecords, expenseKey, {
          name: rows.expense.name,
          cost: rows.expense.costMinor,
          date: rows.expense.date,
          spendingCategoryId: category?.id ?? null,
          economicRole: rows.expense.economicRole,
          costType: rows.expense.costType,
          trade: rows.expense.trade,
          lineKind: rows.expense.lineKind,
          lineBasis: rows.expense.lineBasis,
          bookingTransactionCode: transaction.shortcode,
          purchaseId,
          future: false,
        });
        const beneficiary = value("beneficiaries");
        const shares = Array.isArray(beneficiary) ? beneficiary : [];
        for (const [index, share] of shares.entries()) {
          if (!share || typeof share !== "object" || Array.isArray(share))
            continue;
          const partyId =
            typeof share.partyId === "string"
              ? c.reference("ledgerParty", share.partyId)
              : null;
          if (typeof share.weight === "number")
            book(attributionRecords, `beneficiary:${index}`, {
              expenseId,
              role: "beneficiary",
              ledgerPartyId: partyId,
              weight: share.weight,
            });
        }
      }
      book(allocationRecords, ownKey(c, allocationRecords, "allocation"), {
        transactionId: transaction.id,
        purchaseId,
        amountMinor: rows.allocation.amountMinor,
        confirmsMerchant: rows.allocation.confirmsMerchant,
      });
      // A charge that moved to another Purchase, or no longer needs its lump or
      // a beneficiary share, removes what this scope booked for it before.
      for (const target of targets)
        for (const key of c.existing(target))
          if (!declared.has(`${target.name}:${key}`))
            c.retire(
              target,
              key,
              target === bookingVendors ? "keep" : "remove",
            );
      for (const occurrence of sources) {
        c.bind(
          { kind: "sourceOccurrence", id: occurrence.id },
          purchaseId,
          existingTarget ? "decision" : "proven",
        );
        if (occurrence.currentObservationId)
          c.bind(
            {
              kind: "statementObservation",
              id: occurrence.currentObservationId,
            },
            purchaseId,
            existingTarget ? "decision" : "proven",
          );
      }
      return c.done();
    },
  });

  return purchaseEvent;
}
