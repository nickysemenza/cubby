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
  type ScopeReads,
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
/**
 * Keep a record this scope does not re-derive. A member's decisions on its
 * own fields still apply, so a gap never swallows an edit.
 */
function keep(c: Pure, input: Input, target: ColumnRef, key: string) {
  const id = c.recordId(target, key);
  const rows: readonly { id: string; deletedAt: Date | null }[] =
    target === purchaseRecords
      ? input.purchases
      : target === expenseRecords
        ? input.expenses
        : target === allocationRecords
          ? input.allocations
          : target === attributionRecords
            ? input.attributions
            : [];
  const decided =
    !!id &&
    rows.some((row) => row.id === id && !row.deletedAt) &&
    [
      ...c.assignments(recordSubject(target.entity ?? target.name, id)).keys(),
    ].some((field) => target.columns.includes(field));
  if (decided) record(c, target, key, {});
  else c.retire(target, key, "keep");
}
function retained(c: Pure, input: Input) {
  for (const target of targets)
    for (const key of c.existing(target)) keep(c, input, target, key);
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
/** Whether a Purchase this scope created holds spending of another charge or author. */
function holdsOtherSpending(c: Pure, input: Input, purchaseId: string | null) {
  const own = new Set(
    targets.flatMap((target) =>
      c.existing(target).map((key) => c.recordId(target, key)),
    ),
  );
  return (
    input.expenses.some(
      (row) =>
        !row.deletedAt && row.purchaseId === purchaseId && !own.has(row.id),
    ) ||
    input.allocations.some(
      (row) =>
        !row.deletedAt &&
        row.purchaseId === purchaseId &&
        row.transactionId !== input.key,
    )
  );
}
function ownKey(c: Pure, target: ColumnRef, fallback: string) {
  return c.existing(target)[0] ?? fallback;
}
function graph(
  input: Input,
  purchaseId: string,
  without: ReadonlySet<string | null> = new Set(),
): CapacityRead {
  return {
    lines: input.expenses
      .filter(
        (row) =>
          !row.deletedAt &&
          row.purchaseId === purchaseId &&
          !without.has(row.id),
      )
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
      // Every read records its keys for the scope that needs them, so a
      // batchmate's charge, decision or new Vendor never wakes this scope.
      const each = async <T>(
        run: (key: string, scoped: ScopeReads) => Promise<T>,
      ) =>
        new Map(
          await Promise.all(
            keys.map(
              async (key) => [key, await run(key, reads.for(key))] as const,
            ),
          ),
        );
      const subjectsOf = (key: string) => [
        `purchaseEvent:${key}`,
        recordSubject("financialTransaction", key),
      ];
      const allSubjects = keys.flatMap(subjectsOf);
      const [
        transactionRows,
        manuals,
        decisions,
        bankOwners,
        ownAllocationsByScope,
      ] = await Promise.all([
        each(async (key, scoped) =>
          (await scoped.rows(financialTransaction, [key])).get(key),
        ),
        each(
          async (key, scoped) =>
            (
              await scoped.facts(manualTransactionEvidence, [
                `purchaseEvent:${key}`,
              ])
            ).get(`purchaseEvent:${key}`) ?? [],
        ),
        reads.selectEach(
          decision,
          new Map(keys.map((key) => [key, subjectsOf(key).map(decisionKey)])),
          sql`${decision.subject} = ANY(${textArrayParam(allSubjects)}) OR ${decision.other} = ANY(${textArrayParam(allSubjects)})`,
        ),
        reads.selectEach(
          recordKey,
          new Map(
            keys.map((key) => [key, [`record:financialTransaction:${key}`]]),
          ),
          sql`${recordKey.scopeKind}='bankEvent' AND ${recordKey.entity}=${"financialTransaction"} AND ${recordKey.entityId}=ANY(${textArrayParam(keys)}::uuid[])`,
        ),
        each((key, scoped) =>
          scoped.lookup(
            financialTransactionAllocation,
            transactionAllocations,
            [key],
          ),
        ),
      ]);
      const choicesOf = (key: string) =>
        decisions.filter((row) => row.subject === `purchaseEvent:${key}`);
      // Purchases a member's identity decision names, booked or not.
      const decidedPurchasesOf = (key: string) =>
        decisions.flatMap((row) =>
          [row.subject, row.other].includes(
            recordSubject("financialTransaction", key),
          )
            ? [row.subject, row.other].flatMap((subject) =>
                subject?.startsWith("purchase:")
                  ? [subject.slice("purchase:".length)]
                  : [],
              )
            : [],
        );
      const strings = (value: unknown): string[] =>
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.flatMap(strings)
            : value && typeof value === "object"
              ? Object.values(value).flatMap(strings)
              : [];
      const referencesOf = new Map(
        keys.map((key) => [
          key,
          choicesOf(key).flatMap((row) => strings(row.value)),
        ]),
      );
      const allReferences = [...new Set([...referencesOf.values()].flat())];
      const hashes = new Map(
        await Promise.all(
          keys.map(async (key) => {
            const row = transactionRows.get(key);
            return [
              key,
              row
                ? await inputHashOf(
                    askEnvelope(
                      merchantIdentityAsk,
                      merchantIdentityRequest(
                        statementMerchantIdentityInput({
                          ...row,
                          amount: minorToMoney(row.amount),
                        }) ?? { merchant: "" },
                      ),
                    ),
                  )
                : null,
            ] as const;
          }),
        ),
      );
      const allHashes = [...hashes.values()].filter(
        (hash): hash is string => !!hash,
      );
      const [referenced, saved] = await Promise.all([
        allReferences.length
          ? reads.selectEach(
              entityIdentity,
              new Map(
                keys.map((key) => [
                  key,
                  referencesOf.get(key)!.length
                    ? [decisionKey(`purchaseEvent:${key}`)]
                    : [],
                ]),
              ),
              sql`${entityIdentity.id}::text = ANY(${textArrayParam(allReferences)}) OR ${entityIdentity.shortcode} = ANY(${textArrayParam(allReferences)})`,
            )
          : [],
        reads.selectEach(
          answer,
          new Map(
            keys.map((key) => {
              const hash = hashes.get(key);
              return [key, hash ? [answerKey(hash)] : []];
            }),
          ),
          sql`${answer.inputHash} = ANY(${textArrayParam(allHashes)})`,
        ),
      ]);
      // Each scope follows the merge redirects of the records it references.
      const identitiesByScope = await each(async (key, scoped) => {
        const own = new Set(referencesOf.get(key));
        const identities = referenced.filter(
          (row) =>
            own.has(row.id) || (!!row.shortcode && own.has(row.shortcode)),
        );
        const visited = new Set(identities.map((row) => row.id));
        let redirects = identities.flatMap((row) =>
          row.mergedIntoId && !visited.has(row.mergedIntoId)
            ? [row.mergedIntoId]
            : [],
        );
        while (redirects.length) {
          const rows = await scoped.rows(entityIdentity, redirects);
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
        return identities;
      });
      const referenceIdsOf = (key: string, kind: string) =>
        identitiesByScope
          .get(key)!
          .filter(
            (row) => row.kind === kind && !row.deletedAt && !row.mergedIntoId,
          )
          .map((row) => row.id);
      const answerNameOf = (key: string) =>
        merchantAnswer(
          saved.find((row) => row.inputHash === hashes.get(key))?.output,
        )?.name ?? null;
      const namesOf = (key: string) => {
        const transaction = transactionRows.get(key);
        return new Set(
          [
            transaction?.merchant,
            transaction?.rawDescription,
            answerNameOf(key),
            ...choicesOf(key)
              .filter(
                (row) =>
                  row.field === "vendorName" && typeof row.value === "string",
              )
              .map((row) => String(row.value)),
          ]
            .filter((name): name is string => !!name?.trim())
            .map((name) => name.trim().toLowerCase()),
        );
      };
      const [namedVendors, retainedPurchases, referencedVendors] =
        await Promise.all([
          each((key, scoped) =>
            scoped.lookup(vendor, vendorNames, [...namesOf(key)]),
          ),
          each((key, scoped) =>
            scoped.rows(
              purchase,
              (ownAllocationsByScope.get(key) ?? []).map(
                (row) => row.purchaseId,
              ),
            ),
          ),
          each((key, scoped) =>
            scoped.rows(vendor, referenceIdsOf(key, "vendor")),
          ),
        ]);
      const retainedVendors = await each((key, scoped) =>
        scoped.rows(
          vendor,
          [...retainedPurchases.get(key)!.values()].flatMap((row) =>
            row.vendorId ? [row.vendorId] : [],
          ),
        ),
      );
      const inputs = await Promise.all(
        keys.map(async (key): Promise<readonly [string, Input]> => {
          const scoped = reads.for(key);
          const transaction = transactionRows.get(key);
          const ownManuals = manuals.get(key) ?? [];
          const ownSeeds = ownManuals.flatMap((row) => {
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
          const ownIds = (table: string) =>
            ownSeeds.filter((row) => row.table === table).map((row) => row.id);
          const currentAllocations = ownAllocationsByScope.get(key) ?? [];
          const currentChoices = choicesOf(key);
          const vendors = unique([
            ...namedVendors.get(key)!,
            ...retainedVendors.get(key)!.values(),
            ...referencedVendors.get(key)!.values(),
          ]);
          const names = new Set(
            [
              transaction?.merchant?.trim() ||
                transaction?.rawDescription?.trim(),
              answerNameOf(key),
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
              const purchase = retainedPurchases.get(key)!.get(row.purchaseId);
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
          // A booked charge reads no candidates: its decision needs only its
          // own booking and the Purchases a member names, so a new Purchase
          // never wakes settled history.
          const booked = currentAllocations.some((row) => !row.deletedAt);
          const date = transaction?.transactionDate ?? transaction?.postedDate;
          const [
            candidatePurchases,
            openPurchases,
            exactPayments,
            ownedPurchases,
            bindings,
            occurrences,
            accounts,
          ] = await Promise.all([
            scoped.lookup(
              purchase,
              vendorPurchases,
              booked || !date
                ? []
                : relevantVendors.flatMap((row) =>
                    Array.from(
                      { length: 29 },
                      (_, index) =>
                        `${row.id}:${shiftPlainDate(date, index - 14)}`,
                    ),
                  ),
            ),
            scoped.lookup(
              purchase,
              partlyPaidPurchases,
              booked || transaction?.kind === "refund"
                ? []
                : relevantVendors.map((row) => row.id),
            ),
            scoped.lookup(
              purchasePaymentEvidence,
              amountPayments,
              transaction && !booked ? [String(transaction.amount)] : [],
            ),
            scoped.rows(purchase, [
              key,
              ...ownIds("Purchase"),
              ...referenceIdsOf(key, "purchase"),
              ...decidedPurchasesOf(key),
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
              ...currentAllocations.map((row) => row.purchaseId),
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
            ...(transaction ? [transaction] : []),
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
                [...purchases.values()].flatMap((row) =>
                  row.vendorId ? [row.vendorId] : [],
                ),
              )
            ).values(),
          ]);
          const [parties, categories] = await Promise.all([
            scoped.rows(ledgerParty, [
              ...referenceIdsOf(key, "ledgerParty"),
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
              ...referenceIdsOf(key, "spendingCategory"),
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
                ...currentAllocations,
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
              manuals: ownManuals,
            } satisfies Input,
          ] as const;
        }),
      );
      // Settlement proof reads the occurrences behind every other charge that
      // settles a loaded Purchase, in one statement per source for the batch.
      const settlingOf = new Map(
        inputs.map(([key, input]) => [
          key,
          [
            ...new Set(
              input.allocations
                .filter((row) => !row.deletedAt && row.transactionId !== key)
                .map((row): string => row.transactionId),
            ),
          ],
        ]),
      );
      const settling = [...new Set([...settlingOf.values()].flat())];
      const [settlingOwners, settlingAccepted] = settling.length
        ? await Promise.all([
            reads.selectEach(
              recordKey,
              new Map(
                [...settlingOf].map(([key, ids]) => [
                  key,
                  ids.map((id) => `record:financialTransaction:${id}`),
                ]),
              ),
              sql`${recordKey.scopeKind}='bankEvent' AND ${recordKey.entity}=${"financialTransaction"} AND ${recordKey.entityId}=ANY(${textArrayParam(settling)}::uuid[])`,
            ),
            each((key, scoped) =>
              scoped.lookup(
                sourceOccurrence,
                acceptedOccurrences,
                settlingOf.get(key)!,
              ),
            ),
          ])
        : [[], new Map<string, (typeof sourceOccurrence.$inferSelect)[]>()];
      const ownersOf = (key: string) =>
        settlingOwners.filter(
          (row) =>
            settlingOf.get(key)!.includes(row.entityId) &&
            !row.scopeKey.startsWith("manual:"),
        );
      const ownedOccurrences = settling.length
        ? await each((key, scoped) =>
            scoped.rows(
              sourceOccurrence,
              ownersOf(key).map((row) => row.scopeKey),
            ),
          )
        : new Map<string, Map<string, typeof sourceOccurrence.$inferSelect>>();
      return new Map(
        inputs.map(([key, input]) => [
          key,
          {
            ...input,
            settlementOccurrences: [
              ...ownersOf(key).flatMap((row) => {
                const occurrence = ownedOccurrences.get(key)?.get(row.scopeKey);
                return occurrence
                  ? [{ transactionId: row.entityId, occurrence }]
                  : [];
              }),
              ...(settlingAccepted.get(key) ?? []).flatMap((occurrence) =>
                occurrence.acceptedTransactionId
                  ? [
                      {
                        transactionId: occurrence.acceptedTransactionId,
                        occurrence,
                      },
                    ]
                  : [],
              ),
            ],
          },
        ]),
      );
    },
    // oxlint-disable-next-line complexity -- prerequisite, identity and conservation refusals form one atomic money plan.
    reconcile(input, c) {
      const subject = `purchaseEvent:${input.key}`;
      if (c.decision("rejection", subject)?.kind === "reject") {
        retained(c, input);
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
              keep(c, input, target, key);
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
          retained(c, input);
          return c.done();
        }
        if (decidedBooking(c, subject)) {
          c.gap.unsupported(
            "the charge no longer supports this spending, and the booking carries member decisions",
          );
          retained(c, input);
          return c.done();
        }
        // The Purchase it created stays while it holds other spending: its
        // delete policy would unbook the other charges.
        for (const target of targets)
          for (const key of c.existing(target))
            c.retire(
              target,
              key,
              target === bookingVendors ||
                (target === purchaseRecords &&
                  holdsOtherSpending(c, input, c.recordId(target, key)))
                ? "keep"
                : "remove",
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
        retained(c, input);
        return c.done();
      }
      const account = input.accounts.find(
        (row) => row.id === transaction.accountId && !row.deletedAt,
      );
      if (!account) {
        c.gap.decision("a live financial account");
        retained(c, input);
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
      const selectedFromDecision = typeof value("vendorId") === "string";
      const selectedId = selectedFromDecision
        ? c.reference("vendor", String(value("vendorId")))
        : (existingPurchase?.vendorId ?? null);
      const selected = input.vendors.find(
        (row) => row.id === selectedId && !row.deletedAt,
      );
      const rawResolved = !!checked[0]![0]!.row;
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
        retained(c, input);
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
        retained(c, input);
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
        retained(c, input);
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
      // A chosen Purchase that is gone is the member's to replace; booking a
      // new one would override their choice.
      if (
        typeof value("purchaseId") === "string" &&
        !input.purchases.some(
          (row) => row.id === explicitPurchase && !row.deletedAt,
        )
      ) {
        c.gap.decision(
          "the Purchase chosen for this charge was removed; choose another Purchase or book it on its own",
          {
            actions: [
              {
                channel: "assignment",
                kind: "none",
                subject,
                field: "purchaseId",
                label: "Book it on its own",
              },
            ],
          },
        );
        retained(c, input);
        return c.done();
      }
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
        retained(c, input);
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
        retained(c, input);
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
        retained(c, input);
        return c.done();
      }
      // A charge joins an existing Purchase only where its lines leave room
      // for it; a lump beside priced or unpriced lines counts spending twice.
      // The lump this scope booked there is its own answer, not a line that
      // leaves room, or the next pass would retire it and the one after rebook it.
      const ownExpenses = new Set(
        c
          .existing(expenseRecords)
          .map((key) => c.recordId(expenseRecords, key)),
      );
      const targetGraph = existingTarget
        ? graph(input, existingTarget.id, ownExpenses)
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
        retained(c, input);
        return c.done();
      }
      // Moving the charge retires the Purchase this scope created for it, which
      // must not hold anyone else's spending.
      if (
        existingTarget &&
        existingPurchaseId &&
        holdsOtherSpending(c, input, existingPurchaseId)
      ) {
        c.gap.decision(
          "the Purchase this charge booked holds other spending; reconcile it before moving the charge",
        );
        retained(c, input);
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
        retained(c, input);
        return c.done();
      }
      // The member's attach decision carries the whole move: what it points at
      // the chosen Purchase and what it retires from the generated one apply
      // together, also while a baseline holds other differences.
      const attach = existingTarget
        ? (explicitPurchase
            ? chosen("purchaseId")
            : c.decision(
                "identity",
                identitySubject,
                recordSubject("purchase", existingTarget.id),
              )
          )?.id
        : undefined;
      const moves = attach && existingPurchaseId ? attach : undefined;
      // Each value a member decision supplied cites it, so a held baseline
      // still applies the decision. An explicit Book also covers every other
      // value of the records it creates; it never authorizes changes to
      // records that already exist.
      const decided = (field: string, applies = true) =>
        applies ? chosen(field)?.id : undefined;
      const authority = value("book") === true ? chosen("book")?.id : undefined;
      const vendorChoice =
        selected && selectedFromDecision
          ? decided("vendorId")
          : rawResolved
            ? undefined
            : (decided("vendorName", !!reviewedName) ??
              decided(
                "advice",
                value("advice") !== undefined && !!advice?.vendorName,
              ));
      const declared = new Set<string>();
      const book = (
        target: ColumnRef,
        naturalKey: string,
        values: Parameters<Pure["record"]>[2],
        cites: Record<string, string | undefined> = {},
      ) => {
        declared.add(`${target.name}:${naturalKey}`);
        const created = !c.existing(target).includes(naturalKey);
        const provenance: Record<string, string> = {};
        for (const field of Object.keys(values)) {
          const id =
            (field === "purchaseId" ? attach : undefined) ??
            cites[field] ??
            (created ? authority : undefined);
          if (id) provenance[field] = id;
        }
        return record(c, target, naturalKey, values, provenance);
      };
      if (!resolvedVendor)
        book(
          bookingVendors,
          vendorNaturalKey,
          {
            name: cleanName,
            aliases: merchant && merchant !== cleanName ? [merchant] : [],
          },
          { name: vendorChoice, aliases: vendorChoice },
        );
      if (rows.purchase)
        book(
          purchaseRecords,
          purchaseKey,
          {
            ...rows.purchase,
            vendorId: vendorRow.id,
            purchaserOverrideId: purchaserChoice,
          },
          {
            vendorId: vendorChoice,
            purchaserOverrideId: decided(
              "purchaserId",
              typeof value("purchaserId") === "string",
            ),
          },
        );
      if (rows.expense) {
        const expenseKey = ownKey(c, expenseRecords, "expense");
        const expenseId = book(
          expenseRecords,
          expenseKey,
          {
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
          },
          {
            spendingCategoryId: decided(
              "spendingCategoryId",
              typeof value("spendingCategoryId") === "string",
            ),
            costType: decided(
              "costType",
              value("costType") === "services" || value("costType") === "tools",
            ),
          },
        );
        const beneficiary = value("beneficiaries");
        const shares = Array.isArray(beneficiary) ? beneficiary : [];
        for (const [index, share] of shares.entries()) {
          if (!share || typeof share !== "object" || Array.isArray(share))
            continue;
          const partyId =
            typeof share.partyId === "string"
              ? c.reference("ledgerParty", share.partyId)
              : null;
          if (typeof share.weight === "number") {
            const shareDecision = decided("beneficiaries");
            book(
              attributionRecords,
              `beneficiary:${index}`,
              {
                expenseId,
                role: "beneficiary",
                ledgerPartyId: partyId,
                weight: share.weight,
              },
              {
                expenseId: shareDecision,
                role: shareDecision,
                ledgerPartyId: shareDecision,
                weight: shareDecision,
              },
            );
          }
        }
      }
      book(
        allocationRecords,
        ownKey(c, allocationRecords, "allocation"),
        {
          transactionId: transaction.id,
          purchaseId,
          amountMinor: rows.allocation.amountMinor,
          confirmsMerchant: rows.allocation.confirmsMerchant,
        },
        {
          confirmsMerchant: decided(
            "confirmsMerchant",
            value("confirmsMerchant") !== undefined,
          ),
        },
      );
      // A charge that moved to another Purchase, or no longer needs its lump or
      // a beneficiary share, removes what this scope booked for it before.
      for (const target of targets)
        for (const key of c.existing(target))
          if (!declared.has(`${target.name}:${key}`))
            c.retire(
              target,
              key,
              target === bookingVendors ? "keep" : "remove",
              { decision: moves },
            );
      for (const occurrence of sources) {
        c.bind(
          { kind: "sourceOccurrence", id: occurrence.id },
          purchaseId,
          existingTarget || authority ? "decision" : "proven",
        );
        if (occurrence.currentObservationId)
          c.bind(
            {
              kind: "statementObservation",
              id: occurrence.currentObservationId,
            },
            purchaseId,
            existingTarget || authority ? "decision" : "proven",
          );
      }
      return c.done();
    },
  });

  return purchaseEvent;
}
