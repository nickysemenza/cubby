import type { FieldDecisionStep } from "@cubby/schemas/field-explanation";
import type {
  FieldResolution,
  ResolvedListItem,
} from "@cubby/schemas/field-resolution";
import type {
  InventoryId,
  LedgerPartyId,
  ProductId,
  PurchaseId,
  VendorAccountId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { EffectiveInventoryOwnership } from "@cubby/schemas/inventory-ownership";
import { OWNER_FILTER_HOUSEHOLD, OWNER_FILTER_UNKNOWN } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { expenseAcquisitionSql } from "~/server/db/computed/expense-aggregate-sql";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  inventoryEntry,
  ledgerParty,
  product,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import {
  resolveBeneficiaryEvidence,
  resolvePaymentEvidence,
} from "~/server/domains/inventory/repo/ownership-evidence";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";

type OwnershipEntry = Pick<
  typeof inventoryEntry.$inferSelect,
  "id" | "productId" | "ownershipMode" | "ownerLedgerPartyId"
>;

type IndividualParty = {
  id: LedgerPartyId;
  shortcode: string;
  name: string;
  kind: "member" | "guest";
};

type Acquisition = {
  key: string;
  purchaseId: PurchaseId | null;
  purchaseShortcode: string | null;
  expenseIds: string[];
  vendorAccountId: VendorAccountId | null;
};

type InheritedSource =
  | "inherited_beneficiary"
  | "inherited_vendor_account"
  | "inherited_payment_account";

/** One rung of the inheritance ladder, kept even when an earlier rung wins so
 * an explanation can show what it overrode. */
export type InventoryOwnershipStep = {
  source: InheritedSource | "acquisition";
  reason: FieldDecisionStep["reason"];
  effect: FieldDecisionStep["effect"];
  observed: FieldDecisionStep["observed"];
  owner: IndividualParty | null;
  /** This rung's evidence settles the inherited owner, even as ambiguous. */
  decides: boolean;
  ref: {
    entityKind: "purchase" | "expense" | "vendorAccount" | "financialAccount";
    entityId: string;
  } | null;
};

type InheritedCandidate = {
  owner: IndividualParty | null;
  source: InheritedSource | "unresolved";
  acquisition: Acquisition | null;
  fingerprintEvidence: unknown;
  steps: InventoryOwnershipStep[];
};

const isIndividual = <Party extends { kind: string }>(
  party: Party | undefined,
): party is Party & { kind: "member" | "guest" } =>
  party?.kind === "member" || party?.kind === "guest";

const today = (): string => householdLocalDate();

const acquisitionStep = (
  acquisitions: Acquisition[],
): InventoryOwnershipStep => ({
  source: "acquisition",
  reason:
    acquisitions.length === 0
      ? "acquisition_absent"
      : acquisitions.length === 1
        ? "acquisition_single"
        : "acquisition_multiple",
  effect: acquisitions.length === 1 ? "context" : "blocked",
  owner: null,
  decides: acquisitions.length !== 1,
  ref: null,
  observed: [
    {
      label: "Applicable acquisitions",
      entity: null,
      value: { count: acquisitions.length },
    },
    ...acquisitions.map((acquisition) => ({
      label: "Acquisition",
      entity: acquisition.purchaseShortcode
        ? {
            entityKind: "purchase" as const,
            entityId: acquisition.purchaseShortcode,
          }
        : acquisition.expenseIds[0]
          ? {
              entityKind: "expense" as const,
              entityId: acquisition.expenseIds[0],
            }
          : null,
      value: { expenses: acquisition.expenseIds },
    })),
  ],
});

const unresolvedCandidate = (
  acquisitions: Acquisition[] = [],
): InheritedCandidate => ({
  owner: null,
  source: "unresolved",
  acquisition: null,
  fingerprintEvidence: null,
  steps: [acquisitionStep(acquisitions)],
});

const loadAcquisitionExpenseRows = async (
  client: DrizzleClient | DrizzleTransaction,
  productIds: ProductId[],
) =>
  await client
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      productId: expense.productId,
      purchaseId: expense.purchaseId,
    })
    .from(expense)
    .where(
      and(
        inArray(expense.productId, productIds),
        notDeleted(expense),
        eq(expense.future, false),
        lte(expense.date, today()),
        sql.raw(expenseAcquisitionSql('"Expense"')),
      ),
    );

type AcquisitionExpenseRow = Awaited<
  ReturnType<typeof loadAcquisitionExpenseRows>
>[number];

const loadSparsePurchaseRows = async (
  client: DrizzleClient | DrizzleTransaction,
  productIds: ProductId[],
) =>
  await client
    .select({
      productId: entityLink.toEntityId,
      purchaseId: purchase.id,
      purchaseShortcode: purchase.shortcode,
      vendorAccountId: purchase.vendorAccountId,
    })
    .from(entityLink)
    .innerJoin(
      purchase,
      and(
        eq(entityLink.fromEntityId, purchase.id),
        notDeleted(purchase),
        lte(purchase.date, today()),
      ),
    )
    .where(
      and(
        inArray(entityLink.toEntityId, productIds),
        liveLinks("purchaseProduct"),
      ),
    )
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        productId: parseEntityId("product", row.productId),
      })),
    );

type SparsePurchaseRow = Awaited<
  ReturnType<typeof loadSparsePurchaseRows>
>[number];

const loadPurchaseRows = async (
  client: DrizzleClient | DrizzleTransaction,
  purchaseIds: PurchaseId[],
) => {
  if (purchaseIds.length === 0) return [];
  return await client
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      vendorAccountId: purchase.vendorAccountId,
      date: purchase.date,
    })
    .from(purchase)
    .where(and(inArray(purchase.id, purchaseIds), notDeleted(purchase)));
};

type PurchaseRow = Awaited<ReturnType<typeof loadPurchaseRows>>[number];

const loadPurchaseExpenseRows = async (
  client: DrizzleClient | DrizzleTransaction,
  purchaseIds: PurchaseId[],
) => {
  if (purchaseIds.length === 0) return [];
  return await client
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      purchaseId: expense.purchaseId,
      productId: expense.productId,
      isAcquisition: sql<boolean>`${sql.raw(
        expenseAcquisitionSql('"Expense"'),
      )}`,
    })
    .from(expense)
    .where(
      and(
        inArray(expense.purchaseId, purchaseIds),
        notDeleted(expense),
        eq(expense.future, false),
        lte(expense.date, today()),
      ),
    );
};

type PurchaseExpenseRow = Awaited<
  ReturnType<typeof loadPurchaseExpenseRows>
>[number];

type SingleAcquisition = { productId: ProductId; acquisition: Acquisition };

const groupPurchaseExpenses = (rows: PurchaseExpenseRow[]) => {
  const grouped = new Map<PurchaseId, PurchaseExpenseRow[]>();
  for (const row of rows) {
    if (!row.purchaseId) continue;
    const purchaseRows = grouped.get(row.purchaseId) ?? [];
    purchaseRows.push(row);
    grouped.set(row.purchaseId, purchaseRows);
  }
  return grouped;
};

const addAcquisition = (
  acquisitionsByProduct: Map<ProductId, Map<string, Acquisition>>,
  productId: ProductId,
  acquisition: Acquisition,
) => {
  const acquisitions = acquisitionsByProduct.get(productId) ?? new Map();
  const existing = acquisitions.get(acquisition.key);
  const merged = existing
    ? {
        ...existing,
        expenseIds: [
          ...new Set([...existing.expenseIds, ...acquisition.expenseIds]),
        ].sort(),
      }
    : acquisition;
  acquisitions.set(acquisition.key, merged);
  acquisitionsByProduct.set(productId, acquisitions);
};

const collectAcquisitions = (args: {
  acquisitionExpenseRows: AcquisitionExpenseRow[];
  sparseRows: SparsePurchaseRow[];
  purchaseById: Map<PurchaseId, PurchaseRow>;
  expensesByPurchase: Map<PurchaseId, PurchaseExpenseRow[]>;
}): Map<ProductId, Map<string, Acquisition>> => {
  const acquisitionsByProduct = new Map<ProductId, Map<string, Acquisition>>();
  for (const row of args.acquisitionExpenseRows) {
    if (!row.productId) continue;
    const purchaseRow = row.purchaseId
      ? args.purchaseById.get(row.purchaseId)
      : undefined;
    if (purchaseRow && purchaseRow.date !== null && purchaseRow.date > today())
      continue;
    addAcquisition(acquisitionsByProduct, row.productId, {
      // A removed Purchase no longer supplies a live Product-Purchase
      // relationship, while the Product-linked Expense remains canonical.
      key: purchaseRow ? `purchase:${purchaseRow.id}` : `expense:${row.id}`,
      purchaseId: purchaseRow?.id ?? null,
      purchaseShortcode: purchaseRow?.shortcode ?? null,
      expenseIds: [row.shortcode],
      vendorAccountId: purchaseRow?.vendorAccountId ?? null,
    });
  }

  for (const row of args.sparseRows) {
    const lines = args.expensesByPurchase.get(row.purchaseId) ?? [];
    const targetProductLines = lines.filter(
      (line) => line.productId === row.productId,
    );
    const applicableLines =
      targetProductLines.length > 0
        ? targetProductLines
        : lines.filter((line) => line.productId === null);
    // Unrelated product lines never become evidence for this product. A sparse
    // link with no applicable lines remains valid lump-sum provenance.
    if (
      applicableLines.length > 0 &&
      applicableLines.every((line) => !line.isAcquisition)
    ) {
      continue;
    }
    addAcquisition(acquisitionsByProduct, row.productId, {
      key: `purchase:${row.purchaseId}`,
      purchaseId: row.purchaseId,
      purchaseShortcode: row.purchaseShortcode,
      expenseIds: applicableLines
        .filter((line) => line.isAcquisition)
        .map((line) => line.shortcode)
        .sort(),
      vendorAccountId: row.vendorAccountId,
    });
  }

  return acquisitionsByProduct;
};

const loadBeneficiaryRows = async (
  client: DrizzleClient | DrizzleTransaction,
  expenseCodes: string[],
) => {
  if (expenseCodes.length === 0) return [];
  return await client
    .select({
      expenseShortcode: expense.shortcode,
      ledgerPartyId: expenseAttribution.ledgerPartyId,
      weight: expenseAttribution.weight,
    })
    .from(expenseAttribution)
    .innerJoin(
      expense,
      and(
        eq(expenseAttribution.expenseId, expense.id),
        inArray(expense.shortcode, expenseCodes),
        notDeleted(expense),
      ),
    )
    .where(
      and(
        eq(expenseAttribution.role, "beneficiary"),
        notDeleted(expenseAttribution),
      ),
    );
};

type BeneficiaryRow = Awaited<ReturnType<typeof loadBeneficiaryRows>>[number];

const loadVendorDefaults = async (
  client: DrizzleClient | DrizzleTransaction,
  ids: VendorAccountId[],
) => {
  if (ids.length === 0) return [];
  return await client
    .select({
      id: vendorAccount.id,
      shortcode: vendorAccount.shortcode,
      ledgerPartyId: vendorAccount.ledgerPartyId,
      enabled: vendorAccount.inventoryOwnerDefaultEnabled,
    })
    .from(vendorAccount)
    .where(and(inArray(vendorAccount.id, ids), notDeleted(vendorAccount)));
};

type VendorDefault = Awaited<ReturnType<typeof loadVendorDefaults>>[number];

const loadPaymentDefaults = async (
  client: DrizzleClient | DrizzleTransaction,
  purchaseIds: PurchaseId[],
) => {
  if (purchaseIds.length === 0) return [];
  return await client
    .select({
      purchaseId: financialTransactionAllocation.purchaseId,
      ledgerPartyId: financialAccount.ledgerPartyId,
      enabled: financialAccount.inventoryOwnerDefaultEnabled,
      accountId: financialAccount.id,
      accountShortcode: financialAccount.shortcode,
      transactionId: financialTransaction.id,
      transactionShortcode: financialTransaction.shortcode,
      allocationAmount: financialTransactionAllocation.amount,
    })
    .from(financialTransactionAllocation)
    .innerJoin(
      financialTransaction,
      and(
        eq(
          financialTransactionAllocation.transactionId,
          financialTransaction.id,
        ),
        notDeleted(financialTransaction),
      ),
    )
    .innerJoin(
      financialAccount,
      and(
        eq(financialTransaction.accountId, financialAccount.id),
        notDeleted(financialAccount),
      ),
    )
    .where(
      and(
        inArray(financialTransactionAllocation.purchaseId, purchaseIds),
        notDeleted(financialTransactionAllocation),
        sql`${financialTransaction.amount} > 0`,
        sql`${financialTransactionAllocation.amount} > 0`,
      ),
    );
};

type PaymentDefault = Awaited<ReturnType<typeof loadPaymentDefaults>>[number];

const loadIndividualParties = async (
  client: DrizzleClient | DrizzleTransaction,
  ids: LedgerPartyId[],
) => {
  if (ids.length === 0) return [];
  return await client
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
      kind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .where(and(inArray(ledgerParty.id, ids), notDeleted(ledgerParty)));
};

const indexBeneficiaries = (rows: BeneficiaryRow[]) => {
  const grouped = new Map<string, BeneficiaryRow[]>();
  for (const row of rows) {
    const values = grouped.get(row.expenseShortcode) ?? [];
    values.push(row);
    grouped.set(row.expenseShortcode, values);
  }
  return grouped;
};

const indexPayments = (rows: PaymentDefault[]) => {
  const grouped = new Map<PurchaseId, PaymentDefault[]>();
  for (const row of rows) {
    const values = grouped.get(row.purchaseId) ?? [];
    values.push(row);
    grouped.set(row.purchaseId, values);
  }
  return grouped;
};

const resolveInheritedCandidate = (args: {
  acquisition: Acquisition;
  parties: Map<LedgerPartyId, IndividualParty>;
  partyDetails: Map<
    LedgerPartyId,
    Awaited<ReturnType<typeof loadIndividualParties>>[number]
  >;
  beneficiariesByExpense: Map<string, BeneficiaryRow[]>;
  vendorDefaultById: Map<VendorAccountId, VendorDefault>;
  paymentByPurchase: Map<PurchaseId, PaymentDefault[]>;
}): InheritedCandidate => {
  const { acquisition } = args;
  const partyEvidence = (id: LedgerPartyId | null) => {
    const party = id ? args.partyDetails.get(id) : undefined;
    return party
      ? { id: party.shortcode, name: party.name, kind: party.kind }
      : null;
  };
  const beneficiary = acquisition.expenseIds.flatMap(
    (id) => args.beneficiariesByExpense.get(id) ?? [],
  );
  const beneficiaryResolution = resolveBeneficiaryEvidence({
    applicableExpenseIds: acquisition.expenseIds,
    rows: beneficiary,
    isIndividual: (id) => args.parties.has(id),
  });
  const beneficiaryOwnerId =
    beneficiaryResolution.status === "owner"
      ? beneficiaryResolution.ownerId
      : null;
  const firstExpense = acquisition.expenseIds[0];
  const beneficiaryStep: InventoryOwnershipStep = {
    source: "inherited_beneficiary",
    reason: beneficiaryResolution.reason,
    effect:
      beneficiaryResolution.status === "none"
        ? "fallback"
        : beneficiaryResolution.status === "owner"
          ? "used"
          : "blocked",
    observed: acquisition.expenseIds.map((id) => ({
      label: "Expense beneficiaries",
      fields: ["beneficiaries"],
      entity: { entityKind: "expense", entityId: id },
      value: {
        beneficiaries: (args.beneficiariesByExpense.get(id) ?? []).map(
          (row) => ({
            party: partyEvidence(row.ledgerPartyId),
            partyPresent: row.ledgerPartyId !== null,
            weight: row.weight,
          }),
        ),
      },
    })),
    owner: beneficiaryOwnerId
      ? (args.parties.get(beneficiaryOwnerId) ?? null)
      : null,
    decides: beneficiaryResolution.status !== "none",
    ref: acquisition.purchaseShortcode
      ? { entityKind: "purchase", entityId: acquisition.purchaseShortcode }
      : firstExpense
        ? { entityKind: "expense", entityId: firstExpense }
        : null,
  };

  const vendorDefault = acquisition.vendorAccountId
    ? args.vendorDefaultById.get(acquisition.vendorAccountId)
    : undefined;
  const vendorStep: InventoryOwnershipStep = {
    source: "inherited_vendor_account",
    reason: !vendorDefault
      ? "vendor_absent"
      : !vendorDefault.enabled
        ? "vendor_disabled"
        : !args.parties.has(vendorDefault.ledgerPartyId)
          ? "vendor_unusable"
          : "vendor_enabled",
    effect: vendorDefault?.enabled
      ? args.parties.has(vendorDefault.ledgerPartyId)
        ? "used"
        : "blocked"
      : "fallback",
    observed: vendorDefault
      ? [
          {
            label: "Vendor account policy",
            fields: ["inventoryOwnerDefaultEnabled", "ledgerPartyId"],
            entity: {
              entityKind: "vendorAccount",
              entityId: vendorDefault.shortcode,
            },
            value: {
              inventoryOwnerDefaultEnabled: vendorDefault.enabled,
              party: partyEvidence(vendorDefault.ledgerPartyId),
              partyPresent: true,
            },
          },
        ]
      : [],
    owner: vendorDefault?.enabled
      ? (args.parties.get(vendorDefault.ledgerPartyId) ?? null)
      : null,
    decides: vendorDefault?.enabled ?? false,
    ref: vendorDefault
      ? { entityKind: "vendorAccount", entityId: vendorDefault.shortcode }
      : null,
  };

  const payments = acquisition.purchaseId
    ? (args.paymentByPurchase.get(acquisition.purchaseId) ?? [])
    : [];
  const paymentResolution = resolvePaymentEvidence({
    rows: payments,
    isIndividual: (id) => args.parties.has(id),
  });
  const paymentOwnerId = paymentResolution.ownerId;
  const paymentAccounts = [
    ...new Set(payments.map((row) => row.accountShortcode)),
  ];
  const paymentStep: InventoryOwnershipStep = {
    source: "inherited_payment_account",
    reason: paymentResolution.reason,
    effect: paymentOwnerId ? "used" : "blocked",
    observed: payments.map((row) => ({
      label: "Payment account policy",
      fields: ["inventoryOwnerDefaultEnabled", "ledgerPartyId"],
      entity: {
        entityKind: "financialAccount",
        entityId: row.accountShortcode,
      },
      value: {
        inventoryOwnerDefaultEnabled: row.enabled,
        party: partyEvidence(row.ledgerPartyId),
        partyPresent: row.ledgerPartyId !== null,
        transaction: row.transactionShortcode,
        allocationAmount: row.allocationAmount,
      },
    })),
    owner: paymentOwnerId ? (args.parties.get(paymentOwnerId) ?? null) : null,
    // The last rung always settles: no payment evidence is itself unresolved.
    decides: true,
    ref:
      paymentAccounts.length === 1 && paymentAccounts[0]
        ? { entityKind: "financialAccount", entityId: paymentAccounts[0] }
        : null,
  };

  const steps = [beneficiaryStep, vendorStep, paymentStep];
  const winner = steps.find((step) => step.decides) ?? paymentStep;
  for (const step of steps.slice(steps.indexOf(winner) + 1))
    step.effect = "overridden";
  const fingerprintEvidence =
    winner === beneficiaryStep
      ? {
          beneficiary: beneficiary
            .map((row) => ({
              expenseShortcode: row.expenseShortcode,
              ledgerPartyId: row.ledgerPartyId,
              weight: row.weight,
            }))
            .sort((a, b) =>
              `${a.expenseShortcode}:${a.ledgerPartyId ?? ""}`.localeCompare(
                `${b.expenseShortcode}:${b.ledgerPartyId ?? ""}`,
              ),
            ),
        }
      : winner === vendorStep
        ? { vendorDefault }
        : {
            payments: payments
              .map((row) => ({
                transactionId: row.transactionId,
                accountId: row.accountId,
                allocationAmount: row.allocationAmount,
                enabled: row.enabled,
                ledgerPartyId: row.ledgerPartyId,
              }))
              .sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
            vendorDefault: vendorDefault ?? null,
          };
  return {
    owner: winner.owner,
    source:
      winner.owner && winner.source !== "acquisition"
        ? winner.source
        : "unresolved",
    acquisition,
    fingerprintEvidence,
    steps: [acquisitionStep([acquisition]), ...steps],
  };
};

/**
 * Resolve inheritance for every requested product in one bounded set of
 * queries. Acquisition identity is a Purchase where one exists, otherwise the
 * acquisition Expense itself. The map therefore deduplicates repeated lines
 * and an overlapping sparse `purchaseProduct` link by construction.
 */
async function loadInheritedCandidates(
  db: Database | DrizzleTransaction,
  productIds: ProductId[],
): Promise<Map<ProductId, InheritedCandidate>> {
  const unresolved = new Map(
    productIds.map((id) => [id, unresolvedCandidate()] as const),
  );
  if (productIds.length === 0) return unresolved;
  const client = unwrapDb(db);
  const [acquisitionExpenseRows, sparseRows] = await Promise.all([
    loadAcquisitionExpenseRows(client, productIds),
    loadSparsePurchaseRows(client, productIds),
  ]);
  const purchaseIds = [
    ...new Set([
      ...acquisitionExpenseRows.flatMap((row) =>
        row.purchaseId ? [row.purchaseId] : [],
      ),
      ...sparseRows.map((row) => row.purchaseId),
    ] satisfies PurchaseId[]),
  ];
  const [purchaseRows, purchaseExpenses] = await Promise.all([
    loadPurchaseRows(client, purchaseIds),
    loadPurchaseExpenseRows(client, purchaseIds),
  ]);
  const acquisitionsByProduct = collectAcquisitions({
    acquisitionExpenseRows,
    sparseRows,
    purchaseById: new Map(purchaseRows.map((row) => [row.id, row])),
    expensesByPurchase: groupPurchaseExpenses(purchaseExpenses),
  });
  const singleAcquisitions: SingleAcquisition[] = [];
  for (const id of productIds) {
    const acquisitions = [...(acquisitionsByProduct.get(id)?.values() ?? [])];
    unresolved.set(id, unresolvedCandidate(acquisitions));
    if (acquisitions.length === 1)
      singleAcquisitions.push({ productId: id, acquisition: acquisitions[0]! });
  }
  if (singleAcquisitions.length === 0) return unresolved;

  const applicableExpenseCodes = [
    ...new Set(
      singleAcquisitions.flatMap(({ acquisition }) => acquisition.expenseIds),
    ),
  ];
  const vendorAccountIds = singleAcquisitions.flatMap(({ acquisition }) =>
    acquisition.vendorAccountId ? [acquisition.vendorAccountId] : [],
  );
  const [beneficiaryRows, vendorDefaults, paymentDefaults] = await Promise.all([
    loadBeneficiaryRows(client, applicableExpenseCodes),
    loadVendorDefaults(client, vendorAccountIds),
    loadPaymentDefaults(client, purchaseIds),
  ]);
  const candidatePartyIds = [
    ...new Set([
      ...beneficiaryRows.flatMap((row) =>
        row.ledgerPartyId ? [row.ledgerPartyId] : [],
      ),
      ...vendorDefaults.map((row) => row.ledgerPartyId),
      ...paymentDefaults.flatMap((row) =>
        row.ledgerPartyId ? [row.ledgerPartyId] : [],
      ),
    ] satisfies LedgerPartyId[]),
  ];
  const partyRows = await loadIndividualParties(client, candidatePartyIds);
  const parties = new Map(
    partyRows.filter(isIndividual).map((party) => [party.id, party]),
  );
  const partyDetails = new Map(partyRows.map((row) => [row.id, row]));
  const beneficiariesByExpense = indexBeneficiaries(beneficiaryRows);
  const vendorDefaultById = new Map(vendorDefaults.map((row) => [row.id, row]));
  const paymentByPurchase = indexPayments(paymentDefaults);

  for (const { productId, acquisition } of singleAcquisitions) {
    unresolved.set(
      productId,
      resolveInheritedCandidate({
        acquisition,
        parties,
        partyDetails,
        beneficiariesByExpense,
        vendorDefaultById,
        paymentByPurchase,
      }),
    );
  }
  return unresolved;
}

/** Each product's inheritance ladder, for explaining an unstocked product. */
export async function loadInheritedProductSteps(
  db: Database | DrizzleTransaction,
  productIds: ProductId[],
): Promise<Map<ProductId, InventoryOwnershipStep[]>> {
  const candidates = await loadInheritedCandidates(db, productIds);
  return new Map(
    [...candidates].map(([id, candidate]) => [id, candidate.steps] as const),
  );
}

/**
 * The owner each product's single recorded acquisition would hand an
 * `inherit`-mode stock row (beneficiary, then vendor-account, then payment
 * default), or null when that is undeterminable. Same resolution as
 * `loadEffectiveInventoryOwnership`, without needing a stock row to exist.
 */
export async function loadInheritedProductOwners(
  db: Database | DrizzleTransaction,
  productIds: ProductId[],
): Promise<Map<ProductId, IndividualParty | null>> {
  const candidates = await loadInheritedCandidates(db, productIds);
  return new Map(
    [...candidates].map(([id, candidate]) => [id, candidate.owner] as const),
  );
}

const publicOwner = (party: IndividualParty | null) =>
  party
    ? {
        id: parseShortcodeFor("ledgerParty", party.shortcode),
        name: party.name,
        kind: party.kind,
      }
    : null;

const publicAcquisitionEvidence = (acquisition: Acquisition | null) =>
  acquisition
    ? {
        purchaseId: acquisition.purchaseShortcode
          ? parseShortcodeFor("purchase", acquisition.purchaseShortcode)
          : null,
        expenseIds: acquisition.expenseIds.map((id) =>
          parseShortcodeFor("expense", id),
        ),
        acquisitionKey: acquisition.key,
      }
    : null;

const resolveEntryOwnership = async (
  entry: OwnershipEntry,
  inherited: InheritedCandidate,
  explicit: IndividualParty | null,
): Promise<EffectiveInventoryOwnership> => {
  const effective =
    entry.ownershipMode === "explicit" ? explicit : inherited.owner;
  const evidenceFingerprint = await sha256Hex(
    JSON.stringify({
      ownershipMode: entry.ownershipMode,
      explicitOwnerId: explicit?.id ?? null,
      productId: entry.productId,
      acquisition: inherited.acquisition,
      inheritedOwnerId: inherited.owner?.id ?? null,
      inheritedSource: inherited.source,
      evidence: inherited.fingerprintEvidence,
    }),
  );
  return {
    mode: entry.ownershipMode,
    explicitOwner: publicOwner(explicit),
    effectiveOwner: publicOwner(effective),
    inheritedOwner: publicOwner(inherited.owner),
    source:
      entry.ownershipMode === "inherit"
        ? inherited.source
        : explicit
          ? "explicit"
          : "household",
    evidence: publicAcquisitionEvidence(inherited.acquisition),
    evidenceFingerprint,
    matchesInheritedOwner:
      entry.ownershipMode === "explicit" &&
      explicit !== null &&
      inherited.owner?.id === explicit.id,
  };
};

const INHERITED_SOURCE_PHRASES = {
  acquisition: "Acquisition context",
  inherited_beneficiary: "Purchase beneficiary",
  inherited_vendor_account: "Vendor account default",
  inherited_payment_account: "Payment account default",
} satisfies Record<InventoryOwnershipStep["source"], string>;

const OWNERSHIP_SOURCE_ENTITY = {
  purchase: "purchase",
  expense: "expense",
  vendorAccount: "vendorAccount",
  financialAccount: "financialAccount",
} as const;

/**
 * The shared field resolution for an entry's Owner (`ownerLedgerPartyId`),
 * the same contract Project/Task assignees carry: explicit owner wins, an
 * explicit null is household stock (`none`), otherwise the acquisition
 * evidence supplies the inherited owner.
 */
export const inventoryOwnerResolution = (
  ownership: EffectiveInventoryOwnership,
  steps: readonly InventoryOwnershipStep[],
): FieldResolution => {
  // The first deciding rung settles it, even when it settles on nobody (two
  // beneficiaries); a lower rung naming someone does not win past it.
  const decider = steps.find((step) => step.decides);
  const winner = decider?.owner ? decider : undefined;
  const mode =
    ownership.mode === "inherit"
      ? "inherit"
      : ownership.explicitOwner
        ? "explicit"
        : "none";
  return {
    mode,
    storedValue: ownership.explicitOwner?.id ?? null,
    value: ownership.effectiveOwner?.id ?? null,
    fallbackValue: ownership.inheritedOwner?.id ?? null,
    source:
      mode === "inherit"
        ? winner
          ? INHERITED_SOURCE_PHRASES[winner.source]
          : "No unambiguous acquisition evidence"
        : mode === "none"
          ? "Household stock"
          : "Set on this entry",
    sourceEntity:
      mode === "inherit" && winner?.ref
        ? {
            entityKind: OWNERSHIP_SOURCE_ENTITY[winner.ref.entityKind],
            entityId: winner.ref.entityId,
            name: null,
          }
        : null,
    matchesFallback:
      ownership.inheritedOwner !== null &&
      ownership.explicitOwner?.id === ownership.inheritedOwner.id,
    canReset: mode !== "inherit",
  };
};

type InventoryOwnershipTrace = {
  intent: Pick<FieldDecisionStep, "source" | "reason" | "effect" | "observed">;
  ownership: EffectiveInventoryOwnership;
  steps: InventoryOwnershipStep[];
  fallbackSource: FieldResolution["sourceEntity"];
};

/** Each entry's effective ownership plus the inheritance ladder behind it. */
export async function loadInventoryOwnershipTraces(
  db: Database | DrizzleTransaction,
  entries: OwnershipEntry[],
): Promise<Map<InventoryId, InventoryOwnershipTrace>> {
  const productIds = [...new Set(entries.map((entry) => entry.productId))];
  const inheritedByProduct = await loadInheritedCandidates(db, productIds);
  const explicitIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.ownerLedgerPartyId ? [entry.ownerLedgerPartyId] : [],
      ),
    ),
  ];
  const explicitRows =
    explicitIds.length === 0
      ? []
      : await unwrapDb(db)
          .select({
            id: ledgerParty.id,
            shortcode: ledgerParty.shortcode,
            name: ledgerParty.name,
            kind: ledgerParty.kind,
          })
          .from(ledgerParty)
          .where(
            and(inArray(ledgerParty.id, explicitIds), notDeleted(ledgerParty)),
          );
  const explicitById = new Map(
    explicitRows.filter(isIndividual).map((row) => [row.id, row]),
  );

  const resolved = new Map<InventoryId, InventoryOwnershipTrace>();
  for (const entry of entries) {
    const inherited =
      inheritedByProduct.get(entry.productId) ?? unresolvedCandidate();
    const explicit = entry.ownerLedgerPartyId
      ? (explicitById.get(entry.ownerLedgerPartyId) ?? null)
      : null;
    const decider = inherited.steps.find((step) => step.decides);
    resolved.set(entry.id, {
      intent: {
        source: "inventory",
        reason:
          entry.ownershipMode === "inherit"
            ? "inherit"
            : explicit
              ? "explicit"
              : "household",
        effect: entry.ownershipMode === "inherit" ? "fallback" : "used",
        observed: [
          {
            label: "Stored ownership intent",
            entity: null,
            value: {
              mode: entry.ownershipMode,
              owner: explicit?.shortcode ?? null,
              ownerPresent: entry.ownerLedgerPartyId !== null,
            },
          },
        ],
      },
      ownership: await resolveEntryOwnership(entry, inherited, explicit),
      steps:
        entry.ownershipMode === "explicit"
          ? inherited.steps.map((step) =>
              step.effect === "context"
                ? step
                : { ...step, effect: "overridden" },
            )
          : inherited.steps,
      fallbackSource:
        decider?.owner && decider.ref ? { ...decider.ref, name: null } : null,
    });
  }
  return resolved;
}

export async function loadEffectiveInventoryOwnership(
  db: Database | DrizzleTransaction,
  entries: OwnershipEntry[],
): Promise<Map<InventoryId, EffectiveInventoryOwnership>> {
  const traces = await loadInventoryOwnershipTraces(db, entries);
  return new Map(
    [...traces].map(([id, trace]) => [id, trace.ownership] as const),
  );
}

export async function loadEffectiveInventoryOwnershipById(
  db: Database | DrizzleTransaction,
  id: InventoryId,
): Promise<EffectiveInventoryOwnership | null> {
  const row = await unwrapDb(db).query.inventoryEntry.findFirst({
    where: and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)),
    columns: {
      id: true,
      productId: true,
      ownershipMode: true,
      ownerLedgerPartyId: true,
    },
  });
  if (!row) return null;
  return (await loadEffectiveInventoryOwnership(db, [row])).get(id) ?? null;
}

export async function assertIndividualOwner(
  db: DrizzleClient | DrizzleTransaction,
  ownerId: LedgerPartyId,
): Promise<void> {
  const row = await db.query.ledgerParty.findFirst({
    where: and(eq(ledgerParty.id, ownerId), notDeleted(ledgerParty)),
    columns: { kind: true },
  });
  if (!row || !isIndividual(row)) {
    throw new Error("Inventory owners must be live member or guest parties");
  }
}

/** An entry's Owner as the shared filter and rollup see it. */
type OwnerState =
  | {
      kind: "person";
      owner: NonNullable<EffectiveInventoryOwnership["effectiveOwner"]>;
    }
  | { kind: "household" }
  | { kind: "unknown" };

const ownerState = (ownership: EffectiveInventoryOwnership): OwnerState =>
  ownership.effectiveOwner
    ? { kind: "person", owner: ownership.effectiveOwner }
    : ownership.mode === "explicit"
      ? { kind: "household" }
      : { kind: "unknown" };

const ownerFilterValue = (state: OwnerState) =>
  state.kind === "person"
    ? state.owner.id
    : state.kind === "household"
      ? OWNER_FILTER_HOUSEHOLD
      : OWNER_FILTER_UNKNOWN;

async function liveEntryOwnerStates(
  db: Database | DrizzleTransaction,
  productIds?: readonly ProductId[],
) {
  if (productIds?.length === 0) return [];
  const entries = await unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      productId: inventoryEntry.productId,
      ownershipMode: inventoryEntry.ownershipMode,
      ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
    })
    .from(inventoryEntry)
    .where(
      and(
        notDeleted(inventoryEntry),
        productIds
          ? inArray(inventoryEntry.productId, [...productIds])
          : undefined,
      ),
    );
  const ownership = await loadEffectiveInventoryOwnership(db, entries);
  return entries.flatMap((entry) => {
    const resolved = ownership.get(entry.id);
    return resolved
      ? [{ ...entry, ownership: resolved, state: ownerState(resolved) }]
      : [];
  });
}

/**
 * Live entries whose effective Owner matches any filter value: a Ledger Party
 * shortcode, `@household` or `@unknown`. Runs the same resolver as hydration
 * over every live entry, so inherited stock matches; callers narrow SQL by
 * these ids before paging, counts, and totals.
 */
export const inventoryIdsByEffectiveOwner = async (
  db: Database | DrizzleTransaction,
  values: readonly string[],
): Promise<InventoryId[]> => {
  const wanted = new Set(values);
  return (await liveEntryOwnerStates(db))
    .filter(({ state }) => wanted.has(ownerFilterValue(state)))
    .map(({ id }) => id);
};

/**
 * Each Product's Owner rollup: the distinct effective owners of its live
 * entries (a person marked inherited when any of their entries only inherits
 * them), Household, Unknown; a Product with no live entry shows the owner its
 * single acquisition would hand an `inherit` row, or nothing.
 */
export async function loadProductOwners(
  db: Database | DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<Map<ProductId, ResolvedListItem[]>> {
  const states = await liveEntryOwnerStates(db, productIds);
  const stocked = new Set(states.map((entry) => entry.productId));
  const inherited = await loadInheritedProductOwners(
    db,
    productIds.filter((id) => !stocked.has(id)),
  );
  const result = new Map<ProductId, ResolvedListItem[]>();
  for (const id of productIds) {
    const entries = states.filter((entry) => entry.productId === id);
    if (entries.length === 0) {
      const owner = inherited.get(id);
      result.set(
        id,
        owner
          ? [
              {
                label: `${owner.name} · from purchase`,
                ref: { entityKind: "ledgerParty", entityId: owner.shortcode },
                inherited: true,
              },
            ]
          : [],
      );
      continue;
    }
    const people = new Map<string, ResolvedListItem>();
    let household = false;
    let unknown = false;
    for (const { state, ownership } of entries) {
      if (state.kind === "household") household = true;
      else if (state.kind === "unknown") unknown = true;
      else {
        const isInherited = ownership.mode === "inherit";
        const existing = people.get(state.owner.id);
        people.set(state.owner.id, {
          label: state.owner.name,
          ref: { entityKind: "ledgerParty", entityId: state.owner.id },
          inherited: (existing?.inherited ?? false) || isInherited,
        });
      }
    }
    result.set(id, [
      ...[...people.values()].sort((a, b) => a.label.localeCompare(b.label)),
      ...(household
        ? [{ label: "Household", ref: null, inherited: false }]
        : []),
      ...(unknown ? [{ label: "Unknown", ref: null, inherited: true }] : []),
    ]);
  }
  return result;
}

/**
 * Products whose Owner rollup includes any filter value (see
 * `loadProductOwners`), or, with `presence`, whose rollup is (non-)empty.
 * Values and presence OR together, as nullable filters compose.
 */
export async function productIdsByOwner(
  db: Database | DrizzleTransaction,
  values: readonly string[],
  presence?: "has" | "none",
): Promise<ProductId[]> {
  const wanted = new Set(values);
  const [states, unstocked] = await Promise.all([
    liveEntryOwnerStates(db),
    unwrapDb(db)
      .select({ id: product.id })
      .from(product)
      .where(
        and(
          notDeleted(product),
          sql`NOT EXISTS (SELECT 1 FROM "InventoryEntry" ie WHERE ie."productId" = ${product.id} AND ie."deletedAt" IS NULL)`,
        ),
      ),
  ]);
  const inherited = await loadInheritedProductOwners(
    db,
    unstocked.map(({ id }) => id),
  );
  const matches = new Set<ProductId>();
  for (const { productId, state } of states)
    if (wanted.has(ownerFilterValue(state)) || presence === "has")
      matches.add(productId);
  for (const [id, owner] of inherited)
    if (
      (owner !== null && wanted.has(owner.shortcode)) ||
      (presence === "has" && owner !== null) ||
      (presence === "none" && owner === null)
    )
      matches.add(id);
  return [...matches];
}
