import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionCandidate,
  connectionAssessmentEvidence,
  type ConnectionCandidate,
} from "@cubby/schemas/entity-connections";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { and, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import { uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  financialTransactionAllocation,
  inventoryEntry,
  assessmentState,
} from "~/server/db/schema";
import {
  expenseProjectRecommendationContext,
  expenseProjectRecommendationContexts,
  prepareExpenseProjectRecommendationContexts,
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
  orderedEntityLockKinds,
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
      "brandName",
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
      "dates",
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

/** Project the same fingerprint fields before transfer, including only keys the table owns. */
export function connectionRelevantRowSql(kind: string, table: ShortcodeTable) {
  const fields = connectionRelevantFields(kind);
  const pairs = Object.entries(getTableColumns(table))
    .filter(([name]) => fields.includes(name))
    .flatMap(([name, column]) => [sql`${name}::text`, sql`${column}`]);
  return pairs.length
    ? sql<unknown>`jsonb_build_object(${sql.join(pairs, sql`, `)})`
    : sql<unknown>`'{}'::jsonb`;
}

const jsonEvidence = z.json();
type ConnectionJson = z.infer<typeof jsonEvidence>;
const snapshotSchema = z
  .unknown()
  .transform((value) => JSON.parse(JSON.stringify(value)))
  .pipe(jsonEvidence);
export const snapshotJson = (value: unknown) => snapshotSchema.parse(value);

/** Shared capture children are immutable; no caller can change a sibling's evidence. */
function freezeSnapshot(value: ConnectionJson): ConnectionJson {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

export const connectionReadEvidence = connectionAssessmentEvidence.omit({
  basis: true,
});

/** Lists validate the candidate; stored snapshots stay in PostgreSQL. */
export const connectionReadEvidenceSql = (evidence: SQL) => sql<unknown>`CASE
  WHEN ${evidence} ? 'basis' THEN jsonb_build_object(
    'version', ${evidence}->'version', 'candidate', ${evidence}->'candidate'
  ) ELSE NULL END`;

/** JSONB equality preserves canonical object/array semantics without downloading the snapshot. */
export async function connectionBasisIsCurrent(
  db: Database,
  assessmentId: string,
  basis: Awaited<ReturnType<typeof captureConnectionBasis>>,
) {
  const [match] = await getDb(db)
    .select({ id: assessmentState.id })
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.id, assessmentId),
        sql`${assessmentState.data}->'connectionEvidence'->'basis' = ${JSON.stringify(basis)}::jsonb`,
      ),
    )
    .limit(1);
  return Boolean(match);
}

/** A source roster can fan out to many proposals; bound the prepared bases themselves. */
export async function forEachConnectionBasis<
  T extends { candidate: ConnectionCandidate },
>(
  db: Database,
  entries: readonly T[],
  visit: (
    entry: T,
    basis: Awaited<ReturnType<typeof captureConnectionBasis>>,
  ) => Promise<void>,
  expenseProjects?: Awaited<
    ReturnType<typeof prepareExpenseProjectRecommendationContexts>
  >,
) {
  const expenseIds = entries.flatMap(({ candidate }) =>
    candidate.relation === "expense-project"
      ? [parseShortcodeFor("expense", candidate.source.entityId)]
      : [],
  );
  const preparedExpenseProjects =
    expenseProjects ??
    (expenseIds.length
      ? await prepareExpenseProjectRecommendationContexts(db, expenseIds)
      : undefined);
  // Every candidate for one source carries the same frozen recommendation evidence.
  // Keep one snapshot across construction batches, never across capture passes.
  const expenseProjectEvidence = new Map<string, ConnectionJson>();
  const batchSize = 16;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const prepared = await prepareConnectionBases(
      db,
      batch.map((entry) => entry.candidate),
      preparedExpenseProjects,
    );
    prepared.expenseProjectEvidence = expenseProjectEvidence;
    for (const entry of batch)
      await visit(
        entry,
        await captureConnectionBasis(db, entry.candidate, false, prepared),
      );
  }
}

/** The actual payload row is locked, rather than its independent identity tombstone. */
export async function connectionRecord(
  db: Database,
  ref: EntityRef,
  lock = false,
) {
  const kind = z.enum(shortcodeEntities).parse(ref.entityKind);
  const parsed = parseShortcode(ref.entityId);
  if (parsed?.type !== kind) {
    await resolveOrThrow(db, kind, ref.entityId);
    throw new Error(`Connection ${kind} no longer exists`);
  }
  const table: ShortcodeTable = SHORTCODE_TABLE[kind];
  // One statement by live shortcode: resolving first doubled every record read.
  const query = getDb(db)
    .select({ id: table.id, row: connectionRelevantRowSql(kind, table) })
    .from(table)
    .where(and(eq(table.shortcode, parsed.shortcode), notDeleted(table)))
    .limit(1);
  const [value] = lock ? await query.for("update") : await query;
  // A missing record keeps the resolver's not-found error (retryable: a retry
  // rediscovers without it); only a live code without a row "no longer exists".
  if (!value) {
    await resolveOrThrow(db, kind, ref.entityId);
    throw new Error(`Connection ${kind} no longer exists`);
  }
  return {
    id: parseEntityId(kind, value.id),
    row: snapshotJson(connectionRelevantRow(kind, value.row)),
  };
}

/** Dependency payloads several unlocked captures can share. */
export type PreparedConnectionBases = {
  locked: boolean;
  records: Map<string, Awaited<ReturnType<typeof connectionRecord>>>;
  expenseProject: Map<string, unknown>;
  expenseProjectEvidence: Map<string, ConnectionJson>;
  settlementCandidates: Map<string, unknown>;
  /** By transaction id. */
  allocations: Map<string, unknown[]>;
  /** By `${purchaseId}:${productId}`. */
  purchaseProducts: Map<string, { links: unknown[]; expenses: unknown[] }>;
};

const pairKey = (purchaseId: string, productId: string) =>
  `${purchaseId}:${productId}`;

export const connectionRecordKey = (ref: EntityRef) =>
  `${ref.entityKind}:${ref.entityId}`;

/** `connectionRecord`'s unlocked rows, one statement per entity kind. Codes
 * that do not resolve are left out, so their capture still raises. */
export async function connectionRecords(
  db: Database,
  refs: readonly EntityRef[],
  lock = false,
) {
  const records: PreparedConnectionBases["records"] = new Map();
  const kinds = z.enum(shortcodeEntities);
  const unique = uniqBy(refs, connectionRecordKey);
  const ordered = orderedEntityLockKinds(
    unique.map((ref) => kinds.parse(ref.entityKind)),
  );
  for (const kind of ordered) {
    const kindRefs = unique.filter((ref) => ref.entityKind === kind);
    const codes = new Map(
      kindRefs.flatMap((ref) => {
        const parsed = parseShortcode(ref.entityId);
        return parsed?.type === kind ? [[ref.entityId, parsed.shortcode]] : [];
      }),
    );
    if (codes.size === 0) continue;
    const table: ShortcodeTable = SHORTCODE_TABLE[kind];
    const query = getDb(db)
      .select({
        id: table.id,
        shortcode: table.shortcode,
        row: connectionRelevantRowSql(kind, table),
      })
      .from(table)
      .where(
        and(
          inArray(table.shortcode, [...new Set(codes.values())]),
          notDeleted(table),
        ),
      )
      .orderBy(table.id);
    const rows = lock ? await query.for("update") : await query;
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
  expenseProjects?: Awaited<
    ReturnType<typeof prepareExpenseProjectRecommendationContexts>
  >,
  lock = false,
): Promise<PreparedConnectionBases> {
  const candidates = raws.map((raw) => connectionCandidate.parse(raw));
  const records = await connectionRecords(
    db,
    candidates
      .filter((candidate) => candidate.relation !== "email-purchase")
      .flatMap((candidate) => [candidate.source, candidate.target]),
    lock,
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
  const idOf = (ref: EntityRef) => records.get(connectionRecordKey(ref))?.id;
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
    locked: lock,
    records,
    allocations,
    purchaseProducts,
    expenseProject: expenseProjects
      ? expenseProjects(expenses)
      : await expenseProjectRecommendationContexts(db, expenses),
    expenseProjectEvidence: new Map(),
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
  return (await captureConnectionEvidence(db, raw, lock, prepared)).basis;
}

/**
 * The basis plus the source record id it read (null for Email evidence,
 * whose source is not a payload row), so a locked publication need not
 * resolve the source again.
 */
export async function captureConnectionEvidence(
  db: Database,
  raw: ConnectionCandidate,
  lock = false,
  prepared?: PreparedConnectionBases,
): Promise<{ basis: ConnectionJson; sourceId: string | null }> {
  // An unlocked batch can never satisfy a transaction-time evidence fence.
  if (lock && !prepared?.locked) prepared = undefined;
  const candidate = connectionCandidate.parse(raw);
  if (candidate.relation === "email-purchase")
    return {
      basis: snapshotJson(
        await captureEmailConnectionBasis(db, candidate, lock),
      ),
      sourceId: null,
    };
  // Domain parent locks precede dependent payloads: Purchase before financial
  // rows, Project before Product, and Location before moving Inventory.
  const targetFirst =
    orderedEntityLockKinds([
      candidate.source.entityKind,
      candidate.target.entityKind,
    ])[0] === candidate.target.entityKind;
  const record = async (ref: EntityRef) =>
    prepared?.records.get(connectionRecordKey(ref)) ||
    (await connectionRecord(db, ref, lock));
  const first = await record(targetFirst ? candidate.target : candidate.source);
  const second = await record(
    targetFirst ? candidate.source : candidate.target,
  );
  const source = targetFirst ? second : first;
  const target = targetFirst ? first : second;
  let dependencies: ConnectionJson = null;
  let dependencyEvidence: ConnectionJson | undefined;
  switch (candidate.relation) {
    case "expense-project": {
      const expenseId = parseShortcodeFor("expense", candidate.source.entityId);
      dependencyEvidence = prepared?.expenseProjectEvidence.get(expenseId);
      if (dependencyEvidence === undefined) {
        dependencyEvidence = freezeSnapshot(
          relevantDependencyEvidence(
            snapshotJson(
              prepared?.expenseProject.has(expenseId)
                ? prepared.expenseProject.get(expenseId)
                : await expenseProjectRecommendationContext(db, expenseId),
            ),
          ),
        );
        prepared?.expenseProjectEvidence.set(expenseId, dependencyEvidence);
      }
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
        candidates: prepared?.settlementCandidates.has(purchaseId)
          ? prepared.settlementCandidates.get(purchaseId)
          : await listPurchaseSettlementCandidates(db, purchaseId),
        allocations:
          prepared?.allocations.get(source.id) ||
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
      const prepared_ = prepared?.purchaseProducts.get(
        pairKey(target.id, source.id),
      );
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
  return {
    basis: freezeSnapshot({
      source: source.row,
      target: target.row,
      dependencies:
        dependencyEvidence === undefined
          ? relevantDependencyEvidence(dependencies)
          : dependencyEvidence,
    }),
    sourceId: source.id,
  };
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
