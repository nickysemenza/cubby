import { createHash } from "node:crypto";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { evidenceExpectation } from "@cubby/schemas/purchase-evidence-policy";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";

import {
  unwrapDb,
  uuidArrayParam,
  withTransactionDatabase,
} from "./database-helpers";
import {
  financialTransactionCoverageSql,
  purchaseCoverageSql,
} from "./purchase-evidence-policy";

const policy = evidenceExpectation.exclude(["unknown"]);
export const reviewedEvidencePolicyDecisions = z
  .array(
    z.discriminatedUnion("entity", [
      z
        .object({
          entity: z.literal("vendor"),
          id: z.string(),
          name: z.string(),
          evidenceExpectation: policy,
        })
        .strict(),
      z
        .object({
          entity: z.literal("spendingCategory"),
          id: z.string(),
          name: z.string(),
          evidenceExpectation: policy.optional(),
          productExpectation: policy.optional(),
        })
        .strict()
        .refine(
          (row) =>
            row.evidenceExpectation !== undefined ||
            row.productExpectation !== undefined,
          "A policy field is required",
        ),
    ]),
  )
  .min(1);
type Decisions = z.input<typeof reviewedEvidencePolicyDecisions>;
const liveRow = z.object({
  id: z.string(),
  shortcode: z.string(),
  name: z.string(),
  evidenceExpectation: evidenceExpectation.nullable(),
  productExpectation: evidenceExpectation.optional(),
  parentId: z.string().nullable().optional(),
});
const coverageRow = z.object({
  entity: z.enum(["purchase", "financialTransaction"]),
  id: z.string(),
  coverage: z.record(z.string(), z.string()),
});
const stale = () =>
  createAppError(
    "CONSTRAINT_VIOLATION",
    "Reviewed evidence policy preview changed; review a fresh preview before applying.",
  );

/** Explicit reviewed identities only; no merchant-name classifier or implicit descendant inheritance. */
export async function previewReviewedEvidencePolicies(
  db: Database,
  rawDecisions: Decisions,
) {
  const decisions = reviewedEvidencePolicyDecisions.parse(rawDecisions);
  const keys = decisions.map((row) => `${row.entity}:${row.id}`);
  if (new Set(keys).size !== keys.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Duplicate reviewed policy identity.",
    );
  const database = unwrapDb(db);
  const vendors = z
    .array(liveRow)
    .parse(
      (
        await database.execute(
          sql`SELECT id, shortcode, name, "evidenceExpectation" FROM "Vendor" WHERE "deletedAt" IS NULL ORDER BY id`,
        )
      ).rows,
    );
  const categories = z
    .array(liveRow)
    .parse(
      (
        await database.execute(
          sql`SELECT id, shortcode, name, "evidenceExpectation", "productExpectation", "parentId" FROM "SpendingCategory" WHERE "deletedAt" IS NULL ORDER BY id`,
        )
      ).rows,
    );
  const updates: {
    entity: "vendor" | "spendingCategory";
    id: string;
    uuid: string;
    data: {
      evidenceExpectation?: "required" | "not_expected";
      productExpectation?: "required" | "not_expected";
    };
  }[] = [];
  let preservedFields = 0;
  for (const decision of decisions) {
    const rows = decision.entity === "vendor" ? vendors : categories;
    const row = rows.find((candidate) => candidate.shortcode === decision.id);
    if (!row || row.name !== decision.name)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Reviewed policy identity no longer matches a live record.",
      );
    const data: (typeof updates)[number]["data"] = {};
    if (decision.evidenceExpectation !== undefined) {
      if (
        row.evidenceExpectation === null ||
        row.evidenceExpectation === "unknown"
      )
        data.evidenceExpectation = decision.evidenceExpectation;
      else preservedFields++;
    }
    if (
      decision.entity === "spendingCategory" &&
      decision.productExpectation !== undefined
    ) {
      if (row.productExpectation === "unknown")
        data.productExpectation = decision.productExpectation;
      else preservedFields++;
    }
    if (Object.keys(data).length)
      updates.push({
        entity: decision.entity,
        id: decision.id,
        uuid: row.id,
        data,
      });
  }
  const vendorPatches = Object.fromEntries(
    updates
      .filter((row) => row.entity === "vendor")
      .map((row) => [row.uuid, row.data]),
  );
  const categoryPatches = Object.fromEntries(
    updates
      .filter((row) => row.entity === "spendingCategory")
      .map((row) => [row.uuid, row.data]),
  );
  // Shadow only defaults; every nested expression remains the production coverage calculation.
  const coverage = async (proposed: boolean) =>
    z.array(coverageRow).parse(
      (
        await database.execute(sql`
    WITH "Vendor" AS (SELECT (jsonb_populate_record(NULL::public."Vendor", to_jsonb(v) || COALESCE(${JSON.stringify(proposed ? vendorPatches : {})}::jsonb -> v.id::text, '{}'::jsonb))).* FROM public."Vendor" v),
    "SpendingCategory" AS (SELECT (jsonb_populate_record(NULL::public."SpendingCategory", to_jsonb(c) || COALESCE(${JSON.stringify(proposed ? categoryPatches : {})}::jsonb -> c.id::text, '{}'::jsonb))).* FROM public."SpendingCategory" c)
    SELECT 'purchase' AS entity, p.id::text AS id, ${purchaseCoverageSql("p")} AS coverage FROM "Purchase" p WHERE p."deletedAt" IS NULL
    UNION ALL SELECT 'financialTransaction', t.id::text, ${financialTransactionCoverageSql("t")} FROM "FinancialTransaction" t WHERE t."deletedAt" IS NULL
    ORDER BY entity, id
  `)
      ).rows,
    );
  const before = await coverage(false);
  const after = await coverage(true);
  const transitions: Record<string, number> = {};
  for (let index = 0; index < before.length; index++) {
    const old = before[index]!;
    const next = after[index]!;
    for (const [axis, value] of Object.entries(old.coverage))
      if (next.coverage[axis] !== value) {
        const key = `${old.entity}.${axis}:${value}->${next.coverage[axis]}`;
        transitions[key] = (transitions[key] ?? 0) + 1;
      }
  }
  const receiptVendors = updates
    .filter((row) => row.entity === "vendor" && row.data.evidenceExpectation)
    .map((row) => row.uuid);
  const receiptCategories = updates
    .filter(
      (row) =>
        row.entity === "spendingCategory" && row.data.evidenceExpectation,
    )
    .map((row) => row.uuid);
  const relevant = sql`(p."vendorId" = ANY(${uuidArrayParam(receiptVendors)}) OR p."spendingCategoryId" = ANY(${uuidArrayParam(receiptCategories)}))`;
  const blocked = z
    .object({
      purchaseOverrides: z.number(),
      vendorOverrides: z.number(),
      transactionOverrides: z.number(),
    })
    .parse(
      (
        await database.execute(sql`
    SELECT count(*) FILTER (WHERE p."evidenceExpectation" IS NOT NULL)::int AS "purchaseOverrides",
      count(*) FILTER (WHERE p."evidenceExpectation" IS NULL AND p."spendingCategoryId" = ANY(${uuidArrayParam(receiptCategories)}) AND v."evidenceExpectation" IS NOT NULL AND NOT p."vendorId" = ANY(${uuidArrayParam(receiptVendors)}))::int AS "vendorOverrides",
      (SELECT count(DISTINCT t.id)::int FROM "FinancialTransaction" t LEFT JOIN "FinancialTransactionAllocation" a ON a."transactionId" = t.id AND a."deletedAt" IS NULL LEFT JOIN "Purchase" p ON p.id = a."purchaseId" AND p."deletedAt" IS NULL WHERE t."deletedAt" IS NULL AND t."evidenceExpectation" IS NOT NULL AND (${relevant} OR t."spendingCategoryId" = ANY(${uuidArrayParam(receiptCategories)}))) AS "transactionOverrides"
    FROM "Purchase" p LEFT JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL WHERE p."deletedAt" IS NULL AND ${relevant}
  `)
      ).rows[0],
    );
  const reviewedCategories = new Set(
    decisions
      .filter((row) => row.entity === "spendingCategory")
      .map((row) => categories.find((c) => c.shortcode === row.id)!.id),
  );
  const unreviewedChildren = categories.filter(
    (row) =>
      row.parentId &&
      reviewedCategories.has(row.parentId) &&
      !reviewedCategories.has(row.id),
  ).length;
  // Include graph identity as well as current coverage, so changed allocations,
  // explicit unknown overrides, names and descendants invalidate approval.
  const graph = [];
  for (const table of [
    "Vendor",
    "SpendingCategory",
    "Purchase",
    "FinancialTransaction",
    "FinancialTransactionAllocation",
    "Expense",
    "EntityAttachment",
    "Image",
  ]) {
    graph.push(
      (
        await database.execute(
          sql`SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text, '[]')) AS hash FROM ${sql.identifier(table)} r WHERE r."deletedAt" IS NULL`,
        )
      ).rows[0]?.hash,
    );
  }
  const plan = {
    updates,
    preservedFields,
    transitions,
    blocked,
    unreviewedChildren,
  };
  return {
    ...plan,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ decisions, graph, plan }))
      .digest("hex"),
  };
}

/** Ordinary audited kernel writes, guarded by the entire reviewed effective graph. */
export async function applyReviewedEvidencePolicies(
  ctx: EntityKernelContext,
  decisions: Decisions,
  fingerprint: string,
) {
  return withTransactionDatabase(
    ctx.db,
    async (db) => {
      const plan = await previewReviewedEvidencePolicies(db, decisions);
      if (plan.fingerprint !== fingerprint) throw stale();
      for (const update of plan.updates) {
        if (update.entity === "vendor")
          await executeEntity(
            { ...ctx, db },
            {
              action: "update",
              entity: "vendor",
              id: parseShortcodeFor("vendor", update.id),
              data: { evidenceExpectation: update.data.evidenceExpectation },
            },
          );
        else
          await executeEntity(
            { ...ctx, db },
            {
              action: "update",
              entity: "spendingCategory",
              id: parseShortcodeFor("spendingCategory", update.id),
              data: update.data,
            },
          );
      }
      return {
        updatedEntities: plan.updates.length,
        preservedFields: plan.preservedFields,
        transitions: plan.transitions,
        blocked: plan.blocked,
        unreviewedChildren: plan.unreviewedChildren,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
