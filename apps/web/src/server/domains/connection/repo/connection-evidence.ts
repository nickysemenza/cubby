import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionCandidate,
  type ConnectionCandidate,
} from "@cubby/schemas/entity-connections";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  financialTransactionAllocation,
  inventoryEntry,
} from "~/server/db/schema";
import {
  expenseProjectRecommendationContext,
  expenseProjectRecommendationContexts,
} from "~/server/domains/expense/repo/project-recommendations";
import { suggestFinancialTransferPairs } from "~/server/domains/financial-transaction/repo/financial-transfer-pairing";
import { getProductStockRows } from "~/server/domains/inventory/repo/scan";
import { suggestProjectTools } from "~/server/domains/project/repo/tools";
import {
  listPurchaseSettlementCandidates,
  listPurchasesSettlementCandidates,
} from "~/server/domains/purchase/repo/purchase-settlement-candidates";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
} from "~/server/generic/shortcode/repo/shortcode-tables";

import { captureEmailConnectionBasis } from "./email-connections";

const relevantFields = new Map<string, readonly string[]>(
  Object.entries({
    email: [
      "checksum",
      "orderMailId",
      "ledgerPartyId",
      "receivedAt",
      "subject",
    ],
    product: [
      "name",
      "manufacturer",
      "model",
      "aliases",
      "categoryId",
      "ingredientId",
      "growsPlantId",
      "notes",
    ],
    expense: [
      "name",
      "date",
      "cost",
      "lineKind",
      "future",
      "costType",
      "productId",
      "purchaseId",
      "projectId",
      "trade",
      "vendor",
      "notes",
    ],
    purchase: [
      "orderId",
      "vendorAccountId",
      "date",
      "vendorId",
      "statedTotal",
      "currency",
      "displayLabel",
      "notes",
    ],
    project: [
      "name",
      "kind",
      "status",
      "startDate",
      "endDate",
      "parentProjectId",
      "defaultTrade",
    ],
    financialTransaction: [
      "amount",
      "kind",
      "status",
      "accountId",
      "transactionDate",
      "postedDate",
      "merchant",
      "ledgerTransferId",
    ],
    inventory: [
      "productId",
      "locationId",
      "placement",
      "amountValue",
      "amountUnit",
      "ledgerPartyId",
      "ownerMode",
    ],
    location: ["name", "parentLocationId", "kind"],
    task: [
      "name",
      "projectId",
      "subjectProductId",
      "subjectProductMode",
      "parentTaskId",
      "notes",
    ],
    cookbook: ["name", "author", "productId"],
    device: ["name", "platform", "productId"],
    ingredient: ["name", "aliases", "parentIngredientId"],
    plant: ["name", "variety", "species"],
  }),
);

function connectionRelevantFields(kind: string): readonly string[] {
  return relevantFields.get(kind) ?? ["name"];
}

export function connectionRelevantRow(kind: string, value: unknown) {
  const row = z.record(z.string(), z.json()).parse(value);
  return Object.fromEntries(
    connectionRelevantFields(kind)
      .filter((key) => Object.hasOwn(row, key))
      .map((key) => [key, row[key]]),
  );
}

const jsonEvidence = z.json();
type ConnectionJson = z.infer<typeof jsonEvidence>;
const snapshotSchema = z
  .unknown()
  .transform((value) => JSON.parse(JSON.stringify(value)))
  .pipe(jsonEvidence);
export const snapshotJson = (value: unknown) => snapshotSchema.parse(value);

/** The actual payload row is locked, rather than its independent identity tombstone. */
export async function connectionRecord(
  db: Database,
  ref: EntityRef,
  lock = false,
) {
  const kind = z.enum(shortcodeEntities).parse(ref.entityKind);
  const id = await resolveOrThrow(db, kind, ref.entityId);
  const table: ShortcodeTable = SHORTCODE_TABLE[kind];
  const query = getDb(db)
    .select({ row: sql<unknown>`to_jsonb(${table})` })
    .from(table)
    .where(and(eq(table.id, id), notDeleted(table)))
    .limit(1);
  const [value] = lock ? await query.for("update") : await query;
  if (!value) throw new Error(`Connection ${kind} no longer exists`);
  return { id, row: snapshotJson(connectionRelevantRow(kind, value.row)) };
}

/** Dependency payloads several unlocked captures can share. */
export type PreparedConnectionBases = {
  records: Map<string, Awaited<ReturnType<typeof connectionRecord>>>;
  expenseProject: Map<string, unknown>;
  settlementCandidates: Map<string, unknown>;
  /** By transaction id. */
  allocations: Map<string, unknown[]>;
  /** By `${purchaseId}:${productId}`. */
  purchaseProducts: Map<string, { links: unknown[]; expenses: unknown[] }>;
};

const pairKey = (purchaseId: string, productId: string) =>
  `${purchaseId}:${productId}`;

const recordKey = (ref: EntityRef) => `${ref.entityKind}:${ref.entityId}`;

/** `connectionRecord`'s unlocked rows, one statement per entity kind. Codes
 * that do not resolve are left out, so their capture still raises. */
async function connectionRecords(db: Database, refs: readonly EntityRef[]) {
  const records: PreparedConnectionBases["records"] = new Map();
  const kinds = z.enum(shortcodeEntities);
  const unique = uniqBy(refs, recordKey);
  for (const kind of new Set(
    unique.map((ref) => kinds.parse(ref.entityKind)),
  )) {
    const kindRefs = unique.filter((ref) => ref.entityKind === kind);
    const codes = new Map(
      kindRefs.flatMap((ref) => {
        const parsed = parseShortcode(ref.entityId);
        return parsed?.type === kind ? [[ref.entityId, parsed.shortcode]] : [];
      }),
    );
    if (codes.size === 0) continue;
    const table: ShortcodeTable = SHORTCODE_TABLE[kind];
    const rows = await getDb(db)
      .select({
        id: table.id,
        shortcode: table.shortcode,
        row: sql<unknown>`to_jsonb(${table})`,
      })
      .from(table)
      .where(
        and(
          inArray(table.shortcode, [...new Set(codes.values())]),
          notDeleted(table),
        ),
      );
    const byShortcode = new Map(rows.map((row) => [row.shortcode, row]));
    for (const [code, shortcode] of codes) {
      const value = byShortcode.get(shortcode);
      if (value)
        records.set(`${kind}:${code}`, {
          id: parseEntityId(kind, value.id),
          row: snapshotJson(connectionRelevantRow(kind, value.row)),
        });
    }
  }
  return records;
}

/**
 * Batch the dependency reads of `captureConnectionBasis` for unlocked
 * freshness checks: every Expense-Project candidate shares one project roster
 * and ledger allocation instead of recomputing them per candidate.
 */
export async function prepareConnectionBases(
  db: Database,
  raws: readonly ConnectionCandidate[],
): Promise<PreparedConnectionBases> {
  const candidates = raws.map((raw) => connectionCandidate.parse(raw));
  const records = await connectionRecords(
    db,
    candidates
      .filter((candidate) => candidate.relation !== "email-purchase")
      .flatMap((candidate) => [candidate.source, candidate.target]),
  );
  const expenses = candidates
    .filter((candidate) => candidate.relation === "expense-project")
    .map((candidate) =>
      parseShortcodeFor("expense", candidate.source.entityId),
    );
  const purchases = candidates
    .filter(
      (candidate) =>
        candidate.relation === "transaction-purchase" ||
        candidate.relation === "transaction-refund",
    )
    .map((candidate) =>
      parseShortcodeFor("purchase", candidate.target.entityId),
    );
  const idOf = (ref: EntityRef) => records.get(recordKey(ref))?.id;
  const transactionIds = [
    ...new Set(
      candidates.flatMap((candidate) => {
        const id =
          candidate.relation === "transaction-purchase" ||
          candidate.relation === "transaction-refund"
            ? idOf(candidate.source)
            : undefined;
        return id ? [id] : [];
      }),
    ),
  ];
  const pairs = candidates.flatMap((candidate) => {
    if (candidate.relation !== "product-purchase") return [];
    const productId = idOf(candidate.source);
    const purchaseId = idOf(candidate.target);
    return productId && purchaseId ? [{ productId, purchaseId }] : [];
  });
  const allocations = new Map<string, unknown[]>(
    transactionIds.map((id) => [id, []]),
  );
  if (transactionIds.length)
    for (const row of await getDb(db)
      .select()
      .from(financialTransactionAllocation)
      .where(
        and(
          inArray(
            financialTransactionAllocation.transactionId,
            transactionIds.map((id) =>
              parseEntityId("financialTransaction", id),
            ),
          ),
          notDeleted(financialTransactionAllocation),
        ),
      )
      .orderBy(financialTransactionAllocation.id))
      allocations.get(row.transactionId)?.push(row);
  const purchaseProducts: PreparedConnectionBases["purchaseProducts"] = new Map(
    pairs.map((pair) => [
      pairKey(pair.purchaseId, pair.productId),
      { links: [], expenses: [] },
    ]),
  );
  if (pairs.length) {
    const purchaseIds = [...new Set(pairs.map((pair) => pair.purchaseId))];
    const productIds = [...new Set(pairs.map((pair) => pair.productId))];
    for (const row of await getDb(db)
      .select()
      .from(entityLink)
      .where(
        and(
          liveLinks("purchaseProduct"),
          inArray(entityLink.fromEntityId, purchaseIds),
          inArray(entityLink.toEntityId, productIds),
        ),
      )
      .orderBy(entityLink.id))
      purchaseProducts
        .get(pairKey(row.fromEntityId, row.toEntityId))
        ?.links.push(row);
    for (const row of await getDb(db)
      .select()
      .from(expense)
      .where(
        and(
          inArray(
            expense.purchaseId,
            purchaseIds.map((id) => parseEntityId("purchase", id)),
          ),
          inArray(
            expense.productId,
            productIds.map((id) => parseEntityId("product", id)),
          ),
          notDeleted(expense),
        ),
      )
      .orderBy(expense.id))
      if (row.purchaseId && row.productId)
        purchaseProducts
          .get(pairKey(row.purchaseId, row.productId))
          ?.expenses.push(row);
  }
  return {
    records,
    allocations,
    purchaseProducts,
    expenseProject: await expenseProjectRecommendationContexts(db, expenses),
    settlementCandidates: await listPurchasesSettlementCandidates(
      db,
      purchases,
    ),
  };
}

/** Authoritative family evidence is reread inside the application transaction. */
export async function captureConnectionBasis(
  db: Database,
  raw: ConnectionCandidate,
  lock = false,
  prepared?: PreparedConnectionBases,
) {
  const candidate = connectionCandidate.parse(raw);
  if (candidate.relation === "email-purchase")
    return snapshotJson(await captureEmailConnectionBasis(db, candidate, lock));
  // Domain parent locks precede dependent payloads: Purchase before financial
  // rows, Project before Product, and Location before moving Inventory.
  const targetFirst =
    candidate.target.entityKind === "purchase" ||
    candidate.target.entityKind === "project" ||
    candidate.target.entityKind === "location";
  const record = async (ref: EntityRef) =>
    (!lock && prepared?.records.get(recordKey(ref))) ||
    (await connectionRecord(db, ref, lock));
  const first = await record(targetFirst ? candidate.target : candidate.source);
  const second = await record(
    targetFirst ? candidate.source : candidate.target,
  );
  const source = targetFirst ? second : first;
  const target = targetFirst ? first : second;
  let dependencies: ConnectionJson = null;
  switch (candidate.relation) {
    case "expense-project": {
      const expenseId = parseShortcodeFor("expense", candidate.source.entityId);
      dependencies = snapshotJson(
        !lock && prepared?.expenseProject.has(expenseId)
          ? prepared.expenseProject.get(expenseId)
          : await expenseProjectRecommendationContext(db, expenseId),
      );
      break;
    }
    case "inventory-location": {
      const [stock] = await getDb(db)
        .select({ productId: inventoryEntry.productId })
        .from(inventoryEntry)
        .where(eq(inventoryEntry.id, parseEntityId("inventory", source.id)));
      dependencies = stock
        ? snapshotJson(await getProductStockRows(db, stock.productId))
        : null;
      break;
    }
    case "project-tool":
      dependencies = snapshotJson(
        await suggestProjectTools(
          db,
          await resolveOrThrow(db, "project", candidate.source.entityId),
        ),
      );
      break;
    case "transaction-purchase":
    case "transaction-refund": {
      const purchaseId = parseShortcodeFor(
        "purchase",
        candidate.target.entityId,
      );
      dependencies = snapshotJson({
        candidates:
          !lock && prepared?.settlementCandidates.has(purchaseId)
            ? prepared.settlementCandidates.get(purchaseId)
            : await listPurchaseSettlementCandidates(db, purchaseId),
        allocations:
          (!lock && prepared?.allocations.get(source.id)) ||
          (await getDb(db)
            .select()
            .from(financialTransactionAllocation)
            .where(
              and(
                eq(
                  financialTransactionAllocation.transactionId,
                  parseEntityId("financialTransaction", source.id),
                ),
                notDeleted(financialTransactionAllocation),
              ),
            )
            .orderBy(financialTransactionAllocation.id)),
      });
      break;
    }
    case "transaction-transfer":
      dependencies = snapshotJson(
        await suggestFinancialTransferPairs(db, {
          transactionIds: [
            parseShortcodeFor(
              "financialTransaction",
              candidate.source.entityId,
            ),
          ],
          maxDateDistanceDays: 5,
          maxCandidatesPerTransaction: 3,
        }),
      );
      break;
    case "product-purchase": {
      const prepared_ =
        !lock && prepared?.purchaseProducts.get(pairKey(target.id, source.id));
      if (prepared_) {
        dependencies = snapshotJson(prepared_);
        break;
      }
      dependencies = snapshotJson({
        links: await getDb(db)
          .select()
          .from(entityLink)
          .where(
            and(
              liveLinks("purchaseProduct"),
              eq(entityLink.fromEntityId, target.id),
              eq(entityLink.toEntityId, source.id),
            ),
          )
          .orderBy(entityLink.id),
        expenses: await getDb(db)
          .select()
          .from(expense)
          .where(
            and(
              eq(expense.purchaseId, parseEntityId("purchase", target.id)),
              eq(expense.productId, parseEntityId("product", source.id)),
              notDeleted(expense),
            ),
          )
          .orderBy(expense.id),
      });
      break;
    }
    default:
      break;
  }
  return snapshotJson({
    source: source.row,
    target: target.row,
    dependencies: relevantDependencyEvidence(dependencies),
  });
}

function relevantDependencyEvidence(value: ConnectionJson): ConnectionJson {
  if (Array.isArray(value)) return value.map(relevantDependencyEvidence);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !["updatedAt", "createdAt", "coverImageUrl", "endedAt"].includes(
              key,
            ),
        )
        .map(([key, child]) => [key, relevantDependencyEvidence(child)]),
    );
  return value;
}
