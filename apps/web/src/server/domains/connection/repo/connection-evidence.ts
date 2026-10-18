import type { EntityRef } from "@cubby/schemas/entity";
import {
  connectionCandidate,
  type ConnectionCandidate,
} from "@cubby/schemas/entity-connections";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  financialTransactionAllocation,
  inventoryEntry,
} from "~/server/db/schema";
import { expenseProjectRecommendationContext } from "~/server/domains/expense/repo/project-recommendations";
import { suggestFinancialTransferPairs } from "~/server/domains/financial-transaction/repo/financial-transfer-pairing";
import { getProductStockRows } from "~/server/domains/inventory/repo/scan";
import { suggestProjectTools } from "~/server/domains/project/repo/tools";
import { listPurchaseSettlementCandidates } from "~/server/domains/purchase/repo/purchase-settlement-candidates";
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
    ingredient: ["name", "parentIngredientId"],
    plant: ["name", "variety", "species"],
  }),
);

export function connectionRelevantRow(kind: string, value: unknown) {
  const row = z.record(z.string(), z.json()).parse(value);
  return Object.fromEntries(
    (relevantFields.get(kind) ?? ["name"])
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

/** Authoritative family evidence is reread inside the application transaction. */
export async function captureConnectionBasis(
  db: Database,
  raw: ConnectionCandidate,
  lock = false,
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
  const first = await connectionRecord(
    db,
    targetFirst ? candidate.target : candidate.source,
    lock,
  );
  const second = await connectionRecord(
    db,
    targetFirst ? candidate.source : candidate.target,
    lock,
  );
  const source = targetFirst ? second : first;
  const target = targetFirst ? first : second;
  let dependencies: ConnectionJson = null;
  switch (candidate.relation) {
    case "expense-project":
      dependencies = snapshotJson(
        await expenseProjectRecommendationContext(
          db,
          parseShortcodeFor("expense", candidate.source.entityId),
        ),
      );
      break;
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
    case "transaction-refund":
      dependencies = snapshotJson({
        candidates: await listPurchaseSettlementCandidates(
          db,
          parseShortcodeFor("purchase", candidate.target.entityId),
        ),
        allocations: await getDb(db)
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
          .orderBy(financialTransactionAllocation.id),
      });
      break;
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
    case "product-purchase":
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
