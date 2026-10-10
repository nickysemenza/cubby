import { createHash } from "node:crypto";

import { parseShortcodeFor, type ExpenseId } from "@cubby/schemas/identifiers";
import { impliedProductFeature } from "@cubby/schemas/product";
import {
  spendingClassificationReviewApplyInput,
  spendingClassificationReviewInput,
  spendingClassificationReviewPreview,
  type SpendingClassificationReviewApplyInput,
  type SpendingClassificationReviewInput,
} from "@cubby/schemas/spending-classification-review";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { product, entityExternalId } from "~/server/db/schema";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";

import {
  notDeleted,
  unwrapDb,
  uuidArrayParam,
  withTransactionDatabase,
} from "./database-helpers";
import {
  spendingClassificationRevision,
  type ExpenseSpendingCategoryResolutionDraft,
} from "./expense-category-resolution";
import {
  expenseJointAllocationSql,
  loadExpenseJointAllocations,
  parseExpenseJointAllocationRows,
  type ExpenseJointAllocationRawRow,
  type ExpenseJointAllocationRow,
} from "./expense-project-allocation";
import { validateProductPolicy } from "./inheritance-validation";
import { getCategoryFeature, resolveProductCategory } from "./product-category";
import { externalIdsContainIsbn } from "./product/update-helpers";
import { resolveAllOrThrow, resolveOrThrow } from "./shortcode-resolver";
import { lockLiveSpendingCategories } from "./spending-category";
import {
  assertReviewedSpendingClassification,
  withReviewedSpendingClassification,
} from "./spending-classification-review-authorization";

const fail = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
const digest = (serialized: string) =>
  createHash("sha256").update(serialized).digest("hex");

async function draftFor(
  db: Database,
  request: SpendingClassificationReviewInput,
): Promise<ExpenseSpendingCategoryResolutionDraft> {
  if (request.action === "products") {
    const categoryId = await resolveOrThrow(
      db,
      "productCategory",
      request.productCategoryId,
    );
    const targetFeature = await getCategoryFeature(db, categoryId);
    const products = [];
    for (const code of request.productIds) {
      const id = await resolveOrThrow(db, "product", code);
      const [current] = await unwrapDb(db)
        .select()
        .from(product)
        .where(and(eq(product.id, id), notDeleted(product)));
      if (!current) return fail("Product is no longer live.");
      if (
        ((await getCategoryFeature(db, current.categoryId)) === "food") !==
        (targetFeature === "food")
      )
        fail(
          "A reviewed spending reassignment cannot change the Food feature; Project and Trade impact require a separate review.",
        );
      const externalIds = await unwrapDb(db)
        .select()
        .from(entityExternalId)
        .where(
          and(
            eq(entityExternalId.entityId, id),
            eq(entityExternalId.entityKind, "product"),
            notDeleted(entityExternalId),
          ),
        );
      const requiredFeature = impliedProductFeature({
        fdc_id: current.fdc_id,
        ingredientId: current.ingredientId,
        hasIsbn: externalIdsContainIsbn(externalIds),
      });
      if (
        (await resolveProductCategory(db, categoryId, requiredFeature)) !==
        categoryId
      )
        fail(
          "The reviewed category conflicts with the Product identity feature.",
        );
      products.push({ id, categoryId });
    }
    return { products };
  }
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
  if (request.action === "spendingCategoryMerge") {
    const keepId = await resolveOrThrow(db, "spendingCategory", request.keepId);
    const categoryRedirects = [];
    for (const code of request.mergeIds)
      categoryRedirects.push({
        id: await resolveOrThrow(db, "spendingCategory", code),
        keepId,
      });
    return { categoryRedirects };
  }
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

type CategoryTotals = Map<
  string | null,
  { name: string | null; cents: bigint }
>;

function addCategoryTotals(
  totals: CategoryTotals,
  rows: ExpenseJointAllocationRow[],
  sign: 1n | -1n,
) {
  for (const row of rows) {
    const key = row.spendingCategoryShortcode;
    totals.set(key, {
      name: row.spendingCategoryName,
      cents:
        (totals.get(key)?.cents ?? 0n) + sign * (row.attributedCents ?? 0n),
    });
  }
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

const expensesWhere = (
  rows: ExpenseJointAllocationRow[],
  predicate: (row: ExpenseJointAllocationRow) => boolean,
) => new Set(rows.filter(predicate).map((row) => row.expenseId)).size;
const uncategorized = (row: ExpenseJointAllocationRow) =>
  row.spendingCategoryId === null || row.categoryIncomplete;
const unpriced = (row: ExpenseJointAllocationRow) => row.sourceCents === null;

/**
 * Live Expenses whose resolution or allocation reads something the draft
 * replaces, widened to every live line of their Purchases because adjustment
 * lines take their principals' categories. A draft replaces only Expense
 * overrides, Product categories, ProductCategory mappings (read by every
 * descendant), Vendor policy (read through the Purchase), and references to
 * merged SpendingCategories. An Expense that reads none of them resolves and
 * allocates identically before and after the draft, so it cannot change, and
 * a later edit to it cannot change this review's outcome. A superset is safe.
 */
async function affectedExpenseIds(
  db: Database,
  draft: ExpenseSpendingCategoryResolutionDraft,
): Promise<ExpenseId[]> {
  const ids = (rows: readonly { id: string }[] = []) =>
    uuidArrayParam(rows.map((row) => row.id));
  const result = await unwrapDb(db).execute<{ id: ExpenseId }>(sql`
    WITH RECURSIVE d AS (
      SELECT ${ids(draft.expenses)} AS expenses, ${ids(draft.products)} AS products,
        ${ids(draft.productCategories)} AS categories, ${ids(draft.vendors)} AS vendors,
        ${ids(draft.categoryRedirects)} AS merged
    ), touched_category AS (
      SELECT c.id FROM "ProductCategory" c, d
      WHERE c.id = ANY(d.categories) OR c."spendingCategoryId" = ANY(d.merged)
      UNION
      SELECT child.id FROM "ProductCategory" child
      JOIN touched_category t ON child."parentId" = t.id
    ), seed AS (
      SELECT e.id, e."purchaseId" FROM d, "Expense" e
      LEFT JOIN "Product" g ON g.id = e."productId"
      LEFT JOIN "Purchase" p ON p.id = e."purchaseId"
      LEFT JOIN "Vendor" v ON v.id = p."vendorId"
      WHERE e."deletedAt" IS NULL AND (
        e.id = ANY(d.expenses)
        OR e."productId" = ANY(d.products)
        OR g."categoryId" IN (SELECT id FROM touched_category)
        OR p."vendorId" = ANY(d.vendors)
        OR e."spendingCategoryId" = ANY(d.merged)
        OR p."spendingCategoryId" = ANY(d.merged)
        OR v."defaultSpendingCategoryId" = ANY(d.merged))
    )
    SELECT e.id FROM "Expense" e
    WHERE e."deletedAt" IS NULL AND (e.id IN (SELECT id FROM seed)
      OR e."purchaseId" IN (SELECT "purchaseId" FROM seed))
    ORDER BY e.id
  `);
  return result.rows.map((row) => row.id);
}

const householdRow = z.object({
  expenseCount: z.coerce.number(),
  uncategorizedCount: z.coerce.number(),
  unpricedCount: z.coerce.number(),
  totals: z.array(
    z.tuple([z.string().nullable(), z.string().nullable(), z.string()]),
  ),
  scoped: z.array(z.custom<ExpenseJointAllocationRawRow>()),
});

/**
 * One current allocation pass, aggregated in SQL so no per-Expense history
 * reaches the Worker, plus the affected Expenses' own allocations.
 */
async function householdAllocations(db: Database, scope: readonly ExpenseId[]) {
  const result = await unwrapDb(db).execute(sql`
    WITH a AS (${expenseJointAllocationSql()})
    SELECT
      (SELECT count(*) FROM "Expense" WHERE "deletedAt" IS NULL) AS "expenseCount",
      (SELECT count(DISTINCT "expenseId") FROM a
        WHERE "spendingCategoryId" IS NULL OR "categoryIncomplete") AS "uncategorizedCount",
      (SELECT count(DISTINCT "expenseId") FROM a WHERE "sourceCents" IS NULL) AS "unpricedCount",
      (SELECT coalesce(jsonb_agg(jsonb_build_array(code, name, cents)), '[]'::jsonb) FROM (
        SELECT "spendingCategoryShortcode" AS code, "spendingCategoryName" AS name,
          coalesce(sum("attributedCents"::bigint), 0)::text AS cents
        FROM a GROUP BY 1, 2) category_total) AS totals,
      (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM a
        WHERE a."expenseId" = ANY(${uuidArrayParam(scope)})) AS scoped
  `);
  const row = householdRow.parse(result.rows[0]);
  const totals: CategoryTotals = new Map(
    row.totals.map(([code, name, cents]) => [
      code,
      { name, cents: BigInt(cents) },
    ]),
  );
  return {
    ...row,
    totals,
    scoped: parseExpenseJointAllocationRows(row.scoped),
  };
}

const scopedFactsRow = z.object({
  digest: z.string(),
});

/**
 * The affected Expenses' rows with their Product and Purchase rows, hashed in
 * SQL; with the policy revision and allocations these are every input to their
 * outcome. An edit that moves an Expense into or out of scope changes the
 * hashed set too. The caller compares allocations for every line.
 */
async function scopedFacts(db: Database, expenseIds: readonly ExpenseId[]) {
  const result = await unwrapDb(db).execute(sql`
    WITH f AS (
      SELECT e.id, jsonb_build_object('expense',to_jsonb(e),'product',to_jsonb(g),'purchase',to_jsonb(p)) AS facts
      FROM "Expense" e
      LEFT JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL
      LEFT JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL
      WHERE e."deletedAt" IS NULL AND e.id = ANY(${uuidArrayParam(expenseIds)})
    )
    SELECT encode(sha256(convert_to(coalesce(string_agg(
        jsonb_build_array(f.id, f.facts)::text, ${"\n"} ORDER BY f.id), ''), 'UTF8')), 'hex') AS digest
    FROM f
  `);
  return scopedFactsRow.parse(result.rows[0]);
}

/**
 * Called within one database snapshot; draft resolution never writes policy
 * rows. Resolving, shipping, and hashing every Expense before and after made
 * the Worker fail at household size, so only affected Expenses are resolved;
 * household totals come from one aggregated pass, adjusted by the affected
 * Expenses' before/after allocations.
 */
async function buildPreview(
  db: Database,
  request: SpendingClassificationReviewInput,
) {
  const draft = await draftFor(db, request);
  const policyRevision = await spendingClassificationRevision(db);
  // Selected Products without Expenses still need stale-review protection.
  const productFacts = draft.products?.length
    ? (
        await unwrapDb(db).execute(
          sql`SELECT to_jsonb(p) AS facts FROM "Product" p WHERE p.id IN (${sql.join(
            draft.products.map((row) => sql`${row.id}::uuid`),
            sql`, `,
          )}) ORDER BY p.id`,
        )
      ).rows
    : [];
  const scope = await affectedExpenseIds(db, draft);
  const facts = await scopedFacts(db, scope);
  const household = await householdAllocations(db, scope);
  // Each affected Expense carries all of its allocations on both sides, so
  // the household figures below adjust exactly.
  const before = household.scoped;
  const after = scope.length
    ? await loadExpenseJointAllocations(db, scope, draft)
    : [];
  const beforeByExpense = allocationsByExpense(before);
  const afterByExpense = allocationsByExpense(after);
  const changed = new Set<string>();
  for (const id of new Set([
    ...beforeByExpense.keys(),
    ...afterByExpense.keys(),
  ])) {
    if (beforeByExpense.get(id) !== afterByExpense.get(id)) changed.add(id);
  }
  const beforeTotals = household.totals;
  const afterTotals: CategoryTotals = new Map(beforeTotals);
  addCategoryTotals(afterTotals, before, -1n);
  addCategoryTotals(afterTotals, after, 1n);
  const adjusted = (
    householdCount: number,
    predicate: (row: ExpenseJointAllocationRow) => boolean,
  ) =>
    householdCount -
    expensesWhere(before, predicate) +
    expensesWhere(after, predicate);
  const categoryDeltas = [...afterTotals.keys()]
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
  return spendingClassificationReviewPreview.parse({
    request,
    policyRevision,
    // Covers global policy plus the affected Expenses only: an edit to an
    // unaffected Expense moves household totals but not this review's
    // outcome (see affectedExpenseIds).
    fingerprint: digest(
      JSON.stringify({
        version: 2,
        request,
        policyRevision,
        productFacts,
        facts: facts.digest,
        before: allocationSnapshot(before),
        after: allocationSnapshot(after),
      }),
    ),
    expenseCount: household.expenseCount,
    changedExpenseCount: changed.size,
    unpricedExpenseCount: adjusted(household.unpricedCount, unpriced),
    beforeUncategorizedExpenseCount: household.uncategorizedCount,
    afterUncategorizedExpenseCount: adjusted(
      household.uncategorizedCount,
      uncategorized,
    ),
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

/** Only a fingerprint-validated transaction may reuse these audited policy writes. */
export async function applyReviewedSpendingClassificationPolicy(
  ctx: EntityKernelContext,
  request: SpendingClassificationReviewInput,
) {
  assertReviewedSpendingClassification(ctx.db);
  if (request.action === "products") {
    for (const id of request.productIds)
      await executeEntity(ctx, {
        action: "update",
        entity: "product",
        id,
        data: { categoryId: request.productCategoryId },
      });
    const admitted = await draftFor(ctx.db, request);
    for (const selected of admitted.products ?? []) {
      const [persisted] = await unwrapDb(ctx.db)
        .select({ categoryId: product.categoryId })
        .from(product)
        .where(eq(product.id, selected.id));
      if (persisted?.categoryId !== selected.categoryId)
        fail("The applied Product category differs from the reviewed target.");
    }
  } else if (request.action === "productCategory") {
    await executeEntity(ctx, {
      action: "update",
      entity: "productCategory",
      id: request.productCategoryId,
      data: {
        spendingCategoryMode: request.spendingCategoryMode,
        spendingCategoryId: request.spendingCategoryId,
      },
    });
  } else if (request.action === "vendor") {
    await executeEntity(ctx, {
      action: "update",
      entity: "vendor",
      id: request.vendorId,
      data: {
        spendingProfile: request.spendingProfile,
        defaultSpendingCategoryId: request.defaultSpendingCategoryId,
      },
    });
  } else if (request.action === "spendingCategoryMerge") {
    await executeEntity(ctx, {
      action: "merge",
      entity: "spendingCategory",
      data: { keepId: request.keepId, mergeIds: request.mergeIds },
    });
  } else {
    for (const id of request.expenseIds)
      await executeEntity(ctx, {
        action: "update",
        entity: "expense",
        id,
        data: { spendingCategoryId: request.spendingCategoryId },
      });
  }
}

export async function applySpendingClassificationReview(
  ctx: EntityKernelContext,
  raw: SpendingClassificationReviewApplyInput,
) {
  const input = spendingClassificationReviewApplyInput.parse(raw);
  // Resolved before the transaction so the lock is its first statement.
  const mergedCategories =
    input.request.action === "spendingCategoryMerge"
      ? await resolveAllOrThrow(ctx.db, "spendingCategory", [
          input.request.keepId,
          ...input.request.mergeIds,
        ])
      : [];
  return withTransactionDatabase(
    ctx.db,
    async (db) => {
      if (mergedCategories.length)
        await lockLiveSpendingCategories(db, mergedCategories);
      const impact = await buildPreview(db, input.request);
      if (impact.fingerprint !== input.fingerprint)
        fail(
          "Spending classification or history changed after preview; review a fresh preview before applying.",
        );
      const context = { ...ctx, db };
      const request = input.request;
      await withReviewedSpendingClassification(db, () =>
        applyReviewedSpendingClassificationPolicy(context, request),
      );
      // A new Vendor, mapping, or Expense category can put a Product where
      // its effective spending category forbids one.
      await validateProductPolicy(db);
      return {
        applied: true as const,
        updatedRecords:
          request.action === "expenses"
            ? request.expenseIds.length
            : request.action === "products"
              ? request.productIds.length
              : request.action === "spendingCategoryMerge"
                ? request.mergeIds.length
                : 1,
        impact,
      };
    },
    { isolationLevel: "serializable" },
  );
}
