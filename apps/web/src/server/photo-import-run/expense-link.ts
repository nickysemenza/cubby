import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  photoGroupProposal,
  product,
  purchase,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { loadPhotoAcceptedSourceLines } from "~/server/repo/photo-product-candidates";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

async function committedGroup(db: Database, runId: string, groupKey: string) {
  const id = await resolveOrThrow(db, "run", runId);
  const [group] = await getDb(db)
    .select({
      productId: photoGroupProposal.productId,
      productName: product.name,
      productCode: product.shortcode,
    })
    .from(photoGroupProposal)
    .innerJoin(
      product,
      and(eq(photoGroupProposal.productId, product.id), notDeleted(product)),
    )
    .where(
      and(
        eq(photoGroupProposal.runId, id),
        eq(photoGroupProposal.groupKey, groupKey),
        eq(photoGroupProposal.state, "committed"),
      ),
    )
    .limit(1);
  if (!group?.productId)
    throw new Error("A committed group with a live Product is required");
  return group;
}

/** Bounded, source-backed lines the reviewer may choose to attribute after approval. */
export async function linkablePhotoGroupExpenses(
  db: Database,
  input: { runId: string; groupKey: string; search?: string },
  actor: Pick<ActorContext, "userId">,
) {
  const group = await committedGroup(db, input.runId, input.groupKey);
  const query = input.search?.trim() || group.productName;
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3)
    .slice(0, 4);
  const patterns = words.length ? words : [query];
  const rows = await getDb(db)
    .select({
      id: expense.id,
      code: expense.shortcode,
      name: expense.name,
      date: expense.date,
      cost: expense.cost,
      productQuantity: expense.productQuantity,
      purchaseId: expense.purchaseId,
      purchaseCode: purchase.shortcode,
      purchaseLabel: purchase.displayLabel,
      lineKind: expense.lineKind,
    })
    .from(expense)
    .leftJoin(
      purchase,
      and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
    )
    .where(
      and(
        notDeleted(expense),
        isNull(expense.productId),
        eq(expense.lineKind, "principal"),
        eq(expense.lineBasis, "item_line"),
        or(
          ...patterns.map((word) =>
            ilike(expense.name, `%${word.replace(/[\\%_]/g, "\\$&")}%`),
          ),
        ),
      ),
    )
    .orderBy(desc(expense.date), desc(expense.id))
    .limit(25);
  const acceptedSourceLines = await loadPhotoAcceptedSourceLines(
    db,
    rows,
    actor,
  );
  return {
    productId: parseShortcodeFor("product", group.productCode),
    productName: group.productName,
    lines: rows.map((row) => ({
      expenseId: parseShortcodeFor("expense", row.code),
      acceptedSourceLines: acceptedSourceLines.get(row.id) ?? [],
      name: row.name,
      date: row.date,
      cost: row.cost,
      productQuantity: row.productQuantity,
      purchaseId: row.purchaseCode
        ? parseShortcodeFor("purchase", row.purchaseCode)
        : null,
      purchaseLabel: row.purchaseLabel,
      expectedQuantityDelta:
        row.productQuantity == null
          ? null
          : row.cost != null && row.cost < 0
            ? -Math.abs(row.productQuantity)
            : row.cost != null && row.cost > 0
              ? Math.abs(row.productQuantity)
              : row.productQuantity,
    })),
  };
}
