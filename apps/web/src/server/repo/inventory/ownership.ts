import type {
  InventoryId,
  LedgerPartyId,
  ProductId,
  PurchaseId,
  VendorAccountId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { EffectiveInventoryOwnership } from "@cubby/schemas/inventory-ownership";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  inventoryEntry,
  ledgerParty,
  purchase,
  purchaseProduct,
  vendorAccount,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { expenseAcquisitionSql } from "~/server/repo/expense-aggregate-sql";
import { sha256Hex } from "~/server/semantic/hash";

import {
  resolveBeneficiaryEvidence,
  resolvePaymentEvidence,
} from "./ownership-evidence";

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

type InheritedCandidate = {
  owner: IndividualParty | null;
  source:
    | "inherited_beneficiary"
    | "inherited_vendor_account"
    | "inherited_payment_account"
    | "unresolved";
  acquisition: Acquisition | null;
  fingerprintEvidence: unknown;
};

const isIndividual = <Party extends { kind: string }>(
  party: Party | undefined,
): party is Party & { kind: "member" | "guest" } =>
  party?.kind === "member" || party?.kind === "guest";

const today = (): string => new Date().toISOString().slice(0, 10);

const unresolvedCandidate = (): InheritedCandidate => ({
  owner: null,
  source: "unresolved",
  acquisition: null,
  fingerprintEvidence: null,
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
      productId: purchaseProduct.productId,
      purchaseId: purchase.id,
      purchaseShortcode: purchase.shortcode,
      vendorAccountId: purchase.vendorAccountId,
    })
    .from(purchaseProduct)
    .innerJoin(
      purchase,
      and(
        eq(purchaseProduct.purchaseId, purchase.id),
        notDeleted(purchase),
        lte(purchase.date, today()),
      ),
    )
    .where(
      and(
        inArray(purchaseProduct.productId, productIds),
        notDeleted(purchaseProduct),
      ),
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

const collectSingleAcquisitions = (args: {
  acquisitionExpenseRows: AcquisitionExpenseRow[];
  sparseRows: SparsePurchaseRow[];
  purchaseById: Map<PurchaseId, PurchaseRow>;
  expensesByPurchase: Map<PurchaseId, PurchaseExpenseRow[]>;
}): SingleAcquisition[] => {
  const acquisitionsByProduct = new Map<ProductId, Map<string, Acquisition>>();
  for (const row of args.acquisitionExpenseRows) {
    if (!row.productId) continue;
    const purchaseRow = row.purchaseId
      ? args.purchaseById.get(row.purchaseId)
      : undefined;
    if (purchaseRow && purchaseRow.date > today()) continue;
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

  return [...acquisitionsByProduct.entries()].flatMap(
    ([productId, acquisitions]) => {
      const values = [...acquisitions.values()];
      return values.length === 1
        ? [{ productId, acquisition: values[0]! }]
        : [];
    },
  );
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
      transactionId: financialTransaction.id,
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
  beneficiariesByExpense: Map<string, BeneficiaryRow[]>;
  vendorDefaultById: Map<VendorAccountId, VendorDefault>;
  paymentByPurchase: Map<PurchaseId, PaymentDefault[]>;
}): InheritedCandidate => {
  const beneficiary = args.acquisition.expenseIds.flatMap(
    (id) => args.beneficiariesByExpense.get(id) ?? [],
  );
  const beneficiaryResolution = resolveBeneficiaryEvidence({
    applicableExpenseIds: args.acquisition.expenseIds,
    rows: beneficiary,
    isIndividual: (id) => args.parties.has(id),
  });
  if (beneficiaryResolution.status !== "none") {
    const ownerId =
      beneficiaryResolution.status === "owner"
        ? beneficiaryResolution.ownerId
        : null;
    const owner = ownerId ? (args.parties.get(ownerId) ?? null) : null;
    return {
      owner,
      source: owner ? "inherited_beneficiary" : "unresolved",
      acquisition: args.acquisition,
      fingerprintEvidence: {
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
      },
    };
  }

  const vendorDefault = args.acquisition.vendorAccountId
    ? args.vendorDefaultById.get(args.acquisition.vendorAccountId)
    : undefined;
  if (vendorDefault?.enabled) {
    const owner = args.parties.get(vendorDefault.ledgerPartyId) ?? null;
    return {
      owner,
      source: owner ? "inherited_vendor_account" : "unresolved",
      acquisition: args.acquisition,
      fingerprintEvidence: { vendorDefault },
    };
  }

  const payments = args.acquisition.purchaseId
    ? (args.paymentByPurchase.get(args.acquisition.purchaseId) ?? [])
    : [];
  const paymentOwnerId = resolvePaymentEvidence({
    rows: payments,
    isIndividual: (id) => args.parties.has(id),
  });
  const owner = paymentOwnerId
    ? (args.parties.get(paymentOwnerId) ?? null)
    : null;
  return {
    owner,
    source: owner ? "inherited_payment_account" : "unresolved",
    acquisition: args.acquisition,
    fingerprintEvidence: {
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
    },
  };
};

/**
 * Resolve inheritance for every requested product in one bounded set of
 * queries. Acquisition identity is a Purchase where one exists, otherwise the
 * acquisition Expense itself. The map therefore deduplicates repeated lines
 * and an overlapping sparse PurchaseProduct edge by construction.
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
  const singleAcquisitions = collectSingleAcquisitions({
    acquisitionExpenseRows,
    sparseRows,
    purchaseById: new Map(purchaseRows.map((row) => [row.id, row])),
    expensesByPurchase: groupPurchaseExpenses(purchaseExpenses),
  });
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
      ...vendorDefaults.flatMap((row) =>
        row.enabled ? [row.ledgerPartyId] : [],
      ),
      ...paymentDefaults.flatMap((row) =>
        row.enabled && row.ledgerPartyId ? [row.ledgerPartyId] : [],
      ),
    ] satisfies LedgerPartyId[]),
  ];
  const partyRows = await loadIndividualParties(client, candidatePartyIds);
  const parties = new Map(
    partyRows.filter(isIndividual).map((party) => [party.id, party]),
  );
  const beneficiariesByExpense = indexBeneficiaries(beneficiaryRows);
  const vendorDefaultById = new Map(vendorDefaults.map((row) => [row.id, row]));
  const paymentByPurchase = indexPayments(paymentDefaults);

  for (const { productId, acquisition } of singleAcquisitions) {
    unresolved.set(
      productId,
      resolveInheritedCandidate({
        acquisition,
        parties,
        beneficiariesByExpense,
        vendorDefaultById,
        paymentByPurchase,
      }),
    );
  }
  return unresolved;
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
    entry.ownershipMode === "person"
      ? explicit
      : entry.ownershipMode === "inherit"
        ? inherited.owner
        : null;
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
  const source =
    entry.ownershipMode === "person"
      ? "explicit"
      : entry.ownershipMode === "unassigned"
        ? "unassigned"
        : inherited.source;
  return {
    mode: entry.ownershipMode,
    explicitOwner: publicOwner(explicit),
    effectiveOwner: publicOwner(effective),
    source,
    basis:
      inherited.acquisition && inherited.owner
        ? "Inferred from the only recorded acquisition"
        : null,
    evidence: publicAcquisitionEvidence(inherited.acquisition),
    evidenceFingerprint,
    matchesInheritedOwner:
      entry.ownershipMode === "person" &&
      explicit !== null &&
      inherited.owner?.id === explicit.id,
  };
};

export async function loadEffectiveInventoryOwnership(
  db: Database | DrizzleTransaction,
  entries: OwnershipEntry[],
): Promise<Map<InventoryId, EffectiveInventoryOwnership>> {
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

  const resolved = new Map<InventoryId, EffectiveInventoryOwnership>();
  for (const entry of entries) {
    const inherited =
      inheritedByProduct.get(entry.productId) ?? unresolvedCandidate();
    const explicit = entry.ownerLedgerPartyId
      ? (explicitById.get(entry.ownerLedgerPartyId) ?? null)
      : null;
    resolved.set(
      entry.id,
      await resolveEntryOwnership(entry, inherited, explicit),
    );
  }
  return resolved;
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
