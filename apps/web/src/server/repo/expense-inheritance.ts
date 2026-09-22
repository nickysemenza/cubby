import {
  type ExpenseLineKind,
  resolveExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import type {
  FieldResolution,
  FieldResolutions,
} from "@cubby/schemas/field-resolution";
import type {
  ProductId,
  ProjectId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/project";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers";
import { categoryFeatureSql } from "~/server/repo/product-category-sql";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

import { effectiveProjectTradeSql } from "./task-project-inheritance";

const column = (alias: string, name: string) => sql.raw(`${alias}."${name}"`);

/**
 * The project an Expense belongs to after applying the ledger inheritance
 * contract. Non-principal purchase adjustments are allocated separately and
 * therefore never expose a scalar project.
 */
export const effectiveExpenseProjectSql = (
  alias = '"Expense"',
): SQL<ProjectId | null> => {
  const lineKind = column(alias, "lineKind");
  const storedProjectId = column(alias, "projectId");
  const purchaseId = column(alias, "purchaseId");
  const productId = column(alias, "productId");

  return sql<ProjectId | null>`CASE
    WHEN ${lineKind} <> 'principal' THEN NULL
    ELSE COALESCE(
      (SELECT explicit_project."id"
       FROM "Project" explicit_project
       WHERE explicit_project."id" = ${storedProjectId}
         AND explicit_project."deletedAt" IS NULL),
      (SELECT purchase_project."id"
       FROM "Purchase" inherited_purchase
       JOIN "Project" purchase_project
         ON purchase_project."id" = inherited_purchase."defaultProjectId"
        AND purchase_project."deletedAt" IS NULL
       WHERE inherited_purchase."id" = ${purchaseId}
         AND inherited_purchase."deletedAt" IS NULL),
      CASE WHEN EXISTS (
        SELECT 1 FROM "Product" food_product
        WHERE food_product."id" = ${productId}
          AND food_product."deletedAt" IS NULL
          AND ${categoryFeatureSql(column("food_product", "categoryId"), "food")}
      ) THEN (
        SELECT household_project."id"
        FROM "Project" household_project
        WHERE household_project."shortcode" = 'PRJ-HSHD'
          AND household_project."deletedAt" IS NULL
        LIMIT 1
      ) END
    )
  END`;
};

/** Effective trade for a principal Expense, including its effective Project ancestry. */
export const effectiveExpenseTradeSql = (
  alias = '"Expense"',
): SQL<Trade | null> => {
  const lineKind = column(alias, "lineKind");
  const storedTrade = column(alias, "trade");
  const purchaseId = column(alias, "purchaseId");
  const projectTrade = effectiveProjectTradeSql(
    effectiveExpenseProjectSql(alias),
  );

  return sql<Trade | null>`CASE
    WHEN ${lineKind} <> 'principal' THEN ${storedTrade}
    ELSE COALESCE(
      ${storedTrade},
      (SELECT inherited_purchase."defaultTrade"
       FROM "Purchase" inherited_purchase
       WHERE inherited_purchase."id" = ${purchaseId}
         AND inherited_purchase."deletedAt" IS NULL),
      ${projectTrade}
    )
  END`;
};

/** Scalar extras used by relational Expense reads. */
export const expenseInheritanceReadExtras = (alias = '"expense"') => {
  const projectId = effectiveExpenseProjectSql(alias);
  const lineKind = column(alias, "lineKind");
  const purchaseId = column(alias, "purchaseId");
  const productId = column(alias, "productId");
  const fallbackProjectId = sql<ProjectId | null>`CASE
    WHEN ${lineKind} <> 'principal' THEN NULL
    ELSE COALESCE(
      (SELECT purchase_project."id" FROM "Purchase" inherited_purchase
       JOIN "Project" purchase_project
         ON purchase_project."id" = inherited_purchase."defaultProjectId"
        AND purchase_project."deletedAt" IS NULL
       WHERE inherited_purchase."id" = ${purchaseId}
         AND inherited_purchase."deletedAt" IS NULL),
      CASE WHEN EXISTS (
        SELECT 1 FROM "Product" food_product
        WHERE food_product."id" = ${productId}
          AND food_product."deletedAt" IS NULL
          AND ${categoryFeatureSql(column("food_product", "categoryId"), "food")}
      ) THEN (SELECT household_project."id" FROM "Project" household_project
        WHERE household_project."shortcode" = 'PRJ-HSHD'
          AND household_project."deletedAt" IS NULL LIMIT 1) END
    ) END`;
  const fallbackTrade = sql<Trade | null>`CASE
    WHEN ${lineKind} <> 'principal' THEN NULL
    ELSE COALESCE(
      (SELECT inherited_purchase."defaultTrade" FROM "Purchase" inherited_purchase
       WHERE inherited_purchase."id" = ${purchaseId}
         AND inherited_purchase."deletedAt" IS NULL),
      ${effectiveProjectTradeSql(projectId)}
    ) END`;
  const projectSource = sql<string>`CASE
    WHEN ${lineKind} <> 'principal' THEN 'purchase allocation'
    WHEN ${column(alias, "projectId")} IS NOT NULL THEN 'expense override'
    WHEN EXISTS (
      SELECT 1 FROM "Purchase" inherited_purchase
      JOIN "Project" purchase_project
        ON purchase_project."id" = inherited_purchase."defaultProjectId"
       AND purchase_project."deletedAt" IS NULL
      WHERE inherited_purchase."id" = ${purchaseId}
        AND inherited_purchase."deletedAt" IS NULL
    ) THEN 'purchase default'
    WHEN ${projectId} IS NOT NULL THEN 'household food default'
    ELSE 'none'
  END`;
  const tradeSource = sql<string>`CASE
    WHEN ${column(alias, "trade")} IS NOT NULL THEN 'expense override'
    WHEN ${lineKind} <> 'principal' THEN 'none'
    WHEN EXISTS (
      SELECT 1 FROM "Purchase" inherited_purchase
      WHERE inherited_purchase."id" = ${purchaseId}
        AND inherited_purchase."deletedAt" IS NULL
        AND inherited_purchase."defaultTrade" IS NOT NULL
    ) THEN 'purchase default'
    WHEN ${effectiveExpenseTradeSql(alias)} IS NOT NULL THEN 'project default'
    ELSE 'none'
  END`;
  return {
    effectiveProjectId: projectId.as("effectiveProjectId"),
    effectiveProjectShortcode: sql<
      string | null
    >`(SELECT p."shortcode" FROM "Project" p WHERE p."id" = ${projectId} AND p."deletedAt" IS NULL)`.as(
      "effectiveProjectShortcode",
    ),
    effectiveProjectName: sql<
      string | null
    >`(SELECT p."name" FROM "Project" p WHERE p."id" = ${projectId} AND p."deletedAt" IS NULL)`.as(
      "effectiveProjectName",
    ),
    effectiveTrade: effectiveExpenseTradeSql(alias).as("effectiveTrade"),
    fallbackProjectShortcode: sql<
      string | null
    >`(SELECT p."shortcode" FROM "Project" p WHERE p."id" = ${fallbackProjectId} AND p."deletedAt" IS NULL)`.as(
      "fallbackProjectShortcode",
    ),
    fallbackTrade: fallbackTrade.as("fallbackTrade"),
    projectResolutionSource: projectSource.as("projectResolutionSource"),
    tradeResolutionSource: tradeSource.as("tradeResolutionSource"),
  };
};

export type ExpenseInheritanceTuple = {
  lineKind: ExpenseLineKind;
  projectId: ProjectId | null;
  productId: ProductId | null;
  purchaseId: PurchaseId | null;
  trade: Trade | null;
};

export type ResolvedExpenseInheritance = {
  effectiveProjectId: ProjectId | null;
  effectiveTrade: Trade | null;
};

export type ExpenseFieldDraft = {
  name?: string | null;
  lineKind?: ExpenseLineKind | "auto";
  projectId?: string | null;
  productId?: string | null;
  purchaseId?: string | null;
  trade?: Trade | null;
};

type DraftResolutionRow = {
  effectiveProjectShortcode: string | null;
  fallbackProjectShortcode: string | null;
  effectiveTrade: Trade | null;
  fallbackTrade: Trade | null;
  purchaseDefaultProjectShortcode: string | null;
  purchaseDefaultTrade: Trade | null;
  foodDefaulted: boolean;
};

const draftProjectResolution = (
  draft: ExpenseFieldDraft,
  row: DraftResolutionRow,
  lineKind: ExpenseLineKind,
  hasExplicitProject: boolean,
): FieldResolution => {
  const purchaseRef = draft.purchaseId
    ? { entityType: "purchase" as const, entityId: draft.purchaseId }
    : null;
  const projectRef = row.effectiveProjectShortcode
    ? {
        entityType: "project" as const,
        entityId: row.effectiveProjectShortcode,
      }
    : null;
  let mode: FieldResolution["mode"] = "inherit";
  let source = "none";
  if (lineKind !== "principal") {
    mode = "allocated";
    source = "purchase allocation";
  } else if (hasExplicitProject) {
    mode = "explicit";
    source = "expense override";
  } else if (row.effectiveProjectShortcode) {
    source = row.purchaseDefaultProjectShortcode
      ? "purchase default"
      : row.foodDefaulted
        ? "household food default"
        : "none";
  }
  return {
    mode,
    storedValue: draft.projectId ?? null,
    value: row.effectiveProjectShortcode,
    fallbackValue: row.fallbackProjectShortcode,
    source,
    sourceEntity: source === "purchase default" ? purchaseRef : projectRef,
    matchesFallback:
      row.effectiveProjectShortcode === row.fallbackProjectShortcode,
    canReset: hasExplicitProject,
  };
};

const draftTradeResolution = (
  draft: ExpenseFieldDraft,
  row: DraftResolutionRow,
  trade: Trade | null,
  lineKind: ExpenseLineKind,
): FieldResolution => {
  const purchaseRef = draft.purchaseId
    ? { entityType: "purchase" as const, entityId: draft.purchaseId }
    : null;
  const projectRef = row.effectiveProjectShortcode
    ? {
        entityType: "project" as const,
        entityId: row.effectiveProjectShortcode,
      }
    : null;
  const source = trade
    ? "expense override"
    : row.purchaseDefaultTrade
      ? "purchase default"
      : row.effectiveTrade
        ? "project default"
        : "none";
  return {
    mode: trade ? "explicit" : "inherit",
    storedValue: trade,
    value: row.effectiveTrade,
    fallbackValue: row.fallbackTrade,
    source,
    sourceEntity:
      source === "purchase default"
        ? purchaseRef
        : source === "project default"
          ? projectRef
          : null,
    matchesFallback: row.effectiveTrade === row.fallbackTrade,
    // A principal line must keep a trade from somewhere (Expense, Purchase, or
    // effective Project) — offering reset with no fallback would only send the
    // write into validateExpenseInheritance's "requires a trade" error.
    canReset:
      trade !== null &&
      (lineKind !== "principal" || row.fallbackTrade !== null),
  };
};

/** Resolve preview/editor provenance without materializing inherited values. */
export async function resolveDraftExpenseFields(
  db: Database | DrizzleTransaction,
  draft: ExpenseFieldDraft,
): Promise<FieldResolutions> {
  const projectId = draft.projectId
    ? await resolveLiveShortcode(db, draft.projectId, "project")
    : null;
  const productId = draft.productId
    ? await resolveLiveShortcode(db, draft.productId, "product")
    : null;
  const purchaseId = draft.purchaseId
    ? await resolveLiveShortcode(db, draft.purchaseId, "purchase")
    : null;
  const lineKind = resolveExpenseLineKind(draft);
  const trade = draft.trade ?? null;

  const result = await unwrapDb(db).execute<DraftResolutionRow>(sql`
    WITH candidate AS (
      SELECT ${lineKind}::text AS "lineKind", ${projectId}::uuid AS "projectId",
        ${productId}::uuid AS "productId", ${purchaseId}::uuid AS "purchaseId",
        ${trade}::text AS "trade"
    ), project_fallback_candidate AS (
      SELECT "lineKind", NULL::uuid AS "projectId", "productId", "purchaseId",
        NULL::text AS "trade"
      FROM candidate
    ), trade_fallback_candidate AS (
      SELECT "lineKind", "projectId", "productId", "purchaseId",
        NULL::text AS "trade"
      FROM candidate
    ), resolved AS (
      SELECT
        ${effectiveExpenseProjectSql("candidate")} AS effective_project_id,
        ${effectiveExpenseTradeSql("candidate")} AS effective_trade,
        ${effectiveExpenseProjectSql("project_fallback_candidate")} AS fallback_project_id,
        ${effectiveExpenseTradeSql("trade_fallback_candidate")} AS fallback_trade
      FROM candidate
      CROSS JOIN project_fallback_candidate
      CROSS JOIN trade_fallback_candidate
    )
    SELECT
      effective_project."shortcode" AS "effectiveProjectShortcode",
      fallback_project."shortcode" AS "fallbackProjectShortcode",
      resolved.effective_trade AS "effectiveTrade",
      resolved.fallback_trade AS "fallbackTrade",
      purchase_project."shortcode" AS "purchaseDefaultProjectShortcode",
      live_purchase."defaultTrade" AS "purchaseDefaultTrade",
      coalesce(${categoryFeatureSql(column("live_product", "categoryId"), "food")}
        AND purchase_project."id" IS NULL, false) AS "foodDefaulted"
    FROM resolved
    LEFT JOIN "Project" effective_project
      ON effective_project."id" = resolved.effective_project_id
     AND effective_project."deletedAt" IS NULL
    LEFT JOIN "Project" fallback_project
      ON fallback_project."id" = resolved.fallback_project_id
     AND fallback_project."deletedAt" IS NULL
    LEFT JOIN "Purchase" live_purchase
      ON live_purchase."id" = ${purchaseId}::uuid
     AND live_purchase."deletedAt" IS NULL
    LEFT JOIN "Project" purchase_project
      ON purchase_project."id" = live_purchase."defaultProjectId"
     AND purchase_project."deletedAt" IS NULL
    LEFT JOIN "Product" live_product
      ON live_product."id" = ${productId}::uuid
     AND live_product."deletedAt" IS NULL
  `);
  const row = result.rows[0];
  if (!row) return {};
  const projectExplicit = lineKind === "principal" && projectId !== null;

  return {
    projectId: draftProjectResolution(draft, row, lineKind, projectExplicit),
    trade: draftTradeResolution(draft, row, trade, lineKind),
  };
}

type ResolutionRow = {
  purchaseIsLive: boolean;
  effectiveProjectId: ProjectId | null;
  effectiveTrade: Trade | null;
};

/**
 * Validate the final stored tuple for any direct Expense write. Callers pass
 * the complete post-update state; this function deliberately does not infer
 * whether a field happened to be present in a patch.
 */
export async function validateExpenseInheritance(
  tx: Database | DrizzleTransaction,
  tuple: ExpenseInheritanceTuple,
): Promise<ResolvedExpenseInheritance> {
  if (tuple.lineKind !== "principal") {
    if (tuple.purchaseId === null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A purchase adjustment must belong to a live Purchase.",
      );
    }
    if (tuple.projectId !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A purchase adjustment cannot store a project; its cost is allocated from the Purchase's principal lines.",
      );
    }
  }

  const result = await unwrapDb(tx).execute<ResolutionRow>(sql`
    WITH candidate AS (
      SELECT
        ${tuple.lineKind}::text AS "lineKind",
        ${tuple.projectId}::uuid AS "projectId",
        ${tuple.productId}::uuid AS "productId",
        ${tuple.purchaseId}::uuid AS "purchaseId",
        ${tuple.trade}::text AS "trade"
    )
    SELECT
      EXISTS (
        SELECT 1 FROM "Purchase" p
        WHERE p."id" = candidate."purchaseId" AND p."deletedAt" IS NULL
      ) AS "purchaseIsLive",
      ${effectiveExpenseProjectSql("candidate")} AS "effectiveProjectId",
      ${effectiveExpenseTradeSql("candidate")} AS "effectiveTrade"
    FROM candidate
  `);
  const row = result.rows[0];
  if (!row) {
    throw createAppError(
      "WRITE_COMMITTED_READBACK_FAILED",
      "Expense validation failed.",
    );
  }
  if (tuple.purchaseId !== null && !row.purchaseIsLive) {
    throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found.");
  }
  if (tuple.lineKind === "principal" && row.effectiveTrade === null) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A principal Expense requires a trade from the Expense, its Purchase, or its effective Project.",
    );
  }
  return {
    effectiveProjectId: row.effectiveProjectId,
    effectiveTrade: row.effectiveTrade,
  };
}
