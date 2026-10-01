import { createHash } from "node:crypto";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  spendingClassificationReviewApplyInput,
  spendingClassificationReviewInput,
  spendingClassificationReviewPreview,
  type SpendingClassificationReviewApplyInput,
  type SpendingClassificationReviewInput,
} from "@cubby/schemas/spending-classification-review";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";

import { unwrapDb, withTransactionDatabase } from "./database-helpers";
import {
  expenseSpendingCategoryResolutionSql,
  spendingClassificationRevision,
  type ExpenseSpendingCategoryResolutionDraft,
} from "./expense-category-resolution";
import {
  loadExpenseJointAllocations,
  type ExpenseJointAllocationRow,
} from "./expense-project-allocation";
import { resolveOrThrow } from "./shortcode-resolver";
import { withReviewedSpendingClassification } from "./spending-classification-review-authorization";

const fail = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
const digest = (serialized: string) =>
  createHash("sha256").update(serialized).digest("hex");
const snapshotRow = z.object({
  id: z.string(),
  facts: z.json(),
  before: z.object({ categoryId: z.string().nullable() }).catchall(z.json()),
  after: z.object({ categoryId: z.string().nullable() }).catchall(z.json()),
});

async function draftFor(
  db: Database,
  request: SpendingClassificationReviewInput,
): Promise<ExpenseSpendingCategoryResolutionDraft> {
  if (request.action === "productCategory") {
    const id = await resolveOrThrow(
      db,
      "productCategory",
      request.productCategoryId,
    );
    return {
      productCategories: [
        {
          id,
          spendingCategoryMode: request.spendingCategoryMode,
          spendingCategoryId: request.spendingCategoryId
            ? await resolveOrThrow(
                db,
                "spendingCategory",
                request.spendingCategoryId,
              )
            : null,
        },
      ],
    };
  }
  if (request.action === "vendor")
    return {
      vendors: [
        {
          id: await resolveOrThrow(db, "vendor", request.vendorId),
          spendingProfile: request.spendingProfile,
          defaultSpendingCategoryId: request.defaultSpendingCategoryId
            ? await resolveOrThrow(
                db,
                "spendingCategory",
                request.defaultSpendingCategoryId,
              )
            : null,
        },
      ],
    };
  const spendingCategoryId = request.spendingCategoryId
    ? await resolveOrThrow(db, "spendingCategory", request.spendingCategoryId)
    : null;
  const ids = [];
  for (const id of request.expenseIds)
    ids.push(await resolveOrThrow(db, "expense", id));
  return { expenses: ids.map((id) => ({ id, spendingCategoryId })) };
}

function allocationSnapshot(rows: ExpenseJointAllocationRow[]) {
  return rows
    .map((row) => ({
      ...row,
      sourceCents: row.sourceCents?.toString() ?? null,
      attributedCents: row.attributedCents?.toString() ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function categoryTotals(rows: ExpenseJointAllocationRow[]) {
  const totals = new Map<
    string | null,
    { name: string | null; cents: bigint }
  >();
  for (const row of rows) {
    const key = row.spendingCategoryShortcode;
    const previous = totals.get(key);
    totals.set(key, {
      name: row.spendingCategoryName,
      cents: (previous?.cents ?? 0n) + (row.attributedCents ?? 0n),
    });
  }
  return totals;
}

function allocationsByExpense(rows: ExpenseJointAllocationRow[]) {
  const values = new Map<string, string[]>();
  for (const row of rows) {
    const previous = values.get(row.expenseId) ?? [];
    previous.push(
      JSON.stringify([
        row.principalExpenseId,
        row.projectId,
        row.spendingCategoryId,
        row.attributedCents?.toString() ?? null,
        row.categoryIncomplete,
      ]),
    );
    values.set(row.expenseId, previous);
  }
  return new Map(
    [...values].map(([id, allocations]) => [
      id,
      JSON.stringify(allocations.sort()),
    ]),
  );
}

/** Called within one database snapshot; draft resolution never writes policy rows. */
async function buildPreview(
  db: Database,
  request: SpendingClassificationReviewInput,
) {
  const draft = await draftFor(db, request);
  const policyRevision = await spendingClassificationRevision(db);
  const facts = z.array(snapshotRow).parse(
    (
      await unwrapDb(db).execute(sql`
    SELECT e.id, jsonb_build_object('expense',to_jsonb(e),'product',to_jsonb(g),'purchase',to_jsonb(p)) AS facts,
      ${expenseSpendingCategoryResolutionSql("e")} AS before,
      ${expenseSpendingCategoryResolutionSql("e", draft)} AS after
    FROM "Expense" e
    LEFT JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL
    LEFT JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL ORDER BY e.id
  `)
    ).rows,
  );
  const before = await loadExpenseJointAllocations(db);
  const after = await loadExpenseJointAllocations(db, undefined, draft);
  const beforeByExpense = allocationsByExpense(before);
  const afterByExpense = allocationsByExpense(after);
  const changed = new Set(
    facts
      .filter((row) => row.before.categoryId !== row.after.categoryId)
      .map((row) => row.id),
  );
  for (const id of new Set([
    ...beforeByExpense.keys(),
    ...afterByExpense.keys(),
  ])) {
    if (beforeByExpense.get(id) !== afterByExpense.get(id)) changed.add(id);
  }
  const beforeTotals = categoryTotals(before);
  const afterTotals = categoryTotals(after);
  const categoryDeltas = [
    ...new Set([...beforeTotals.keys(), ...afterTotals.keys()]),
  ]
    .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
    .map((id) => {
      const beforeCents = beforeTotals.get(id)?.cents ?? 0n;
      const afterCents = afterTotals.get(id)?.cents ?? 0n;
      return {
        spendingCategoryId: id
          ? parseShortcodeFor("spendingCategory", id)
          : null,
        spendingCategoryName:
          afterTotals.get(id)?.name ?? beforeTotals.get(id)?.name ?? null,
        beforeCents: beforeCents.toString(),
        afterCents: afterCents.toString(),
        deltaCents: (afterCents - beforeCents).toString(),
      };
    });
  const unpriced = new Set(
    after.filter((row) => row.sourceCents === null).map((row) => row.expenseId),
  );
  const uncategorizedCount = (rows: ExpenseJointAllocationRow[]) =>
    new Set(
      rows
        .filter(
          (row) => row.spendingCategoryId === null || row.categoryIncomplete,
        )
        .map((row) => row.expenseId),
    ).size;
  return spendingClassificationReviewPreview.parse({
    request,
    policyRevision,
    fingerprint: digest(
      JSON.stringify({
        version: 1,
        request,
        policyRevision,
        facts,
        before: allocationSnapshot(before),
        after: allocationSnapshot(after),
      }),
    ),
    expenseCount: facts.length,
    changedExpenseCount: changed.size,
    unpricedExpenseCount: unpriced.size,
    beforeUncategorizedExpenseCount: uncategorizedCount(before),
    afterUncategorizedExpenseCount: uncategorizedCount(after),
    categoryDeltas,
  });
}

export async function previewSpendingClassificationReview(
  db: Database,
  raw: SpendingClassificationReviewInput,
) {
  const request = spendingClassificationReviewInput.parse(raw);
  return withTransactionDatabase(
    db,
    (snapshot) => buildPreview(snapshot, request),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function applySpendingClassificationReview(
  ctx: EntityKernelContext,
  raw: SpendingClassificationReviewApplyInput,
) {
  const input = spendingClassificationReviewApplyInput.parse(raw);
  return withTransactionDatabase(
    ctx.db,
    async (db) => {
      const impact = await buildPreview(db, input.request);
      if (impact.fingerprint !== input.fingerprint)
        fail(
          "Spending classification or history changed after preview; review a fresh preview before applying.",
        );
      const context = { ...ctx, db };
      const request = input.request;
      await withReviewedSpendingClassification(db, async () => {
        if (request.action === "productCategory") {
          await executeEntity(context, {
            action: "update",
            entity: "productCategory",
            id: request.productCategoryId,
            data: {
              spendingCategoryMode: request.spendingCategoryMode,
              spendingCategoryId: request.spendingCategoryId,
            },
          });
        } else if (request.action === "vendor") {
          await executeEntity(context, {
            action: "update",
            entity: "vendor",
            id: request.vendorId,
            data: {
              spendingProfile: request.spendingProfile,
              defaultSpendingCategoryId: request.defaultSpendingCategoryId,
            },
          });
        } else {
          for (const id of request.expenseIds)
            await executeEntity(context, {
              action: "update",
              entity: "expense",
              id,
              data: { spendingCategoryId: request.spendingCategoryId },
            });
        }
      });
      return {
        applied: true as const,
        updatedRecords:
          request.action === "expenses" ? request.expenseIds.length : 1,
        impact,
      };
    },
    { isolationLevel: "serializable" },
  );
}
