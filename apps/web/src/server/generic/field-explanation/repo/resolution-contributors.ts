import { type Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import {
  fieldResolutionSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import { humanize } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import { formatCurrency } from "~/lib/number-format";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  unwrapDb,
  sqlEnumConstant,
} from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { inventoryEntry, location } from "~/server/db/schema";
import { readExpense } from "~/server/domains/expense/repo/crud";
import { loadExpenseSpendingCategoryEvidence } from "~/server/domains/expense/repo/expense-category-resolution";
import { effectiveExpenseProjectSql } from "~/server/domains/expense/repo/expense-inheritance";
import { expenseJointAllocationSql } from "~/server/domains/expense/repo/expense-project-allocation";
import {
  type InventoryOwnershipStep,
  loadInheritedProductSteps,
  loadInventoryOwnershipTraces,
  inventoryOwnerResolution,
} from "~/server/domains/inventory/repo/ownership";
import { kitAncestorCteSql } from "~/server/domains/product/repo/kit-projection";
import {
  linkedPurchaseItemizationExpectationSql,
  linkedPurchaseItemizationSourceSql,
  purchaseEvidenceFieldResolutionsSql,
  vendorItemizationPolicySql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { declaredInheritanceSteps } from "~/server/generic/inheritance/repo/evidence";
import { fieldEvidencePlan } from "~/server/generic/inheritance/repo/evidence-plans";
import { shortcodeLabels } from "~/server/generic/shortcode/repo/shortcode-labels";

import {
  valueText,
  coverage,
  type Evidence,
  type Step,
  selfStep,
  winnerIndex,
  evidenceBlock,
  resolutionOutcome,
  isTruncated,
  collectCodes,
  labelsForSteps,
  chainBlock,
} from "./evidence-presentation";
const OWNERSHIP_STEP_TITLES = {
  acquisition: "Acquisition context",
  inherited_beneficiary: "Purchase beneficiary",
  inherited_vendor_account: "Vendor account default",
  inherited_payment_account: "Payment account default",
} as const;

const ownershipSteps = (steps: readonly InventoryOwnershipStep[]): Step[] =>
  steps.map((step) => ({
    title: OWNERSHIP_STEP_TITLES[step.source],
    ref: step.ref,
    value: step.owner?.shortcode ?? null,
    assigned: step.decides,
    nullLabel: "No single owner",
    decision: {
      source: step.source,
      reason: step.reason,
      effect: step.effect,
      observed: step.observed,
    },
  }));

const ownershipSelfStep = (
  resolution: FieldResolution,
  decision: Step["decision"],
): Step => ({
  ...selfStep("inventory", resolution),
  nullLabel: "Household",
  decision,
});
async function expenseCategorySteps(
  db: Database,
  shortcode: string,
  resolution: FieldResolution,
): Promise<FieldSteps> {
  const evidence = await loadExpenseSpendingCategoryEvidence(db, shortcode);
  const titles = {
    context: "Vendor food context",
    mapping: null,
    purchase: "Purchase default",
    merchant: "Vendor default without a Product",
  } as const;
  return {
    steps: [
      selfStep("expense", resolution),
      ...(evidence?.steps.map((step) => ({
        title: titles[step.kind] ?? step.ref.name ?? step.ref.entityId,
        ref: step.ref,
        value: step.value,
        assigned: step.assigned,
        unavailableReason:
          step.assigned && !step.applicable
            ? "Not applicable to this line"
            : undefined,
      })) ?? []),
    ],
    fallbackSource: evidence?.fallbackSource ?? null,
  };
}

async function expenseProjectSteps(
  db: Database,
  shortcode: string,
  resolution: FieldResolution,
): Promise<FieldSteps> {
  const entity = "expense";

  const result = await unwrapDb(db).execute(
    sql`
      SELECT p.shortcode AS "purchaseCode",pc.shortcode AS "purchaseProject",
        hp.shortcode AS "foodProject",hp.name AS "foodName",e."lineKind"
      FROM "Expense" e
      LEFT JOIN "Purchase" p ON p.id=e."purchaseId" AND ${notDeleted("p")}
      LEFT JOIN "Project" pc ON pc.id=p."defaultProjectId" AND ${notDeleted("pc")}
      CROSS JOIN LATERAL (SELECT e."lineKind",e."productId",NULL::uuid AS "projectId",NULL::uuid AS "purchaseId") food_candidate
      LEFT JOIN "Project" hp ON hp.id=${effectiveExpenseProjectSql("food_candidate")} AND ${notDeleted("hp")}
      WHERE e.shortcode=${shortcode} AND ${notDeleted("e")}`,
    "objects",
  );
  const row = z
    .object({
      purchaseCode: z.string().nullable(),
      purchaseProject: z.string().nullable(),
      foodProject: z.string().nullable(),
      foodName: z.string().nullable(),
      lineKind: z.string(),
    })
    .optional()
    .parse(result[0]);
  const principal = row?.lineKind === "principal";
  return {
    steps: [
      selfStep(entity, resolution),
      ...(row?.purchaseCode
        ? [
            {
              title: "Purchase default",
              ref: {
                entityKind: "purchase" as const,
                entityId: row.purchaseCode,
              },
              value: row.purchaseProject,
              assigned: Boolean(principal && row.purchaseProject),
            },
          ]
        : []),
      {
        title: "Household food default",
        ref: row?.foodProject
          ? { entityKind: "project", entityId: row.foodProject }
          : null,
        value: row?.foodProject ?? null,
        assigned: Boolean(principal && row?.foodProject),
      },
    ],
    fallbackSource:
      principal && row?.purchaseProject && row.purchaseCode
        ? { entityKind: "purchase", entityId: row.purchaseCode, name: null }
        : row?.foodProject
          ? {
              entityKind: "project",
              entityId: row.foodProject,
              name: row.foodName,
            }
          : null,
  };
}

type FieldSteps = {
  steps: Step[];
  fallbackSource: Evidence["fallbackSource"];
  currentResolution?: FieldResolution;
};

function evaluatedFieldSteps(
  entity: Entity,
  resolution: FieldResolution,
): FieldSteps {
  return {
    steps: [
      selfStep(entity, resolution),
      ...(resolution.evaluation ?? []).map((step) => ({
        title: step.name ?? "Category decision",
        ref: { entityKind: step.entityKind, entityId: step.entityId },
        value: step.value,
        assigned: step.assigned,
      })),
    ],
    fallbackSource: resolution.fallbackSource ?? null,
  };
}

async function inventoryOwnershipFieldSteps(
  db: Database,
  shortcode: string,
  resolution: FieldResolution | null,
): Promise<FieldSteps> {
  const row = await getDb(db).query.inventoryEntry.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(
            eq(inventoryEntry.shortcode, shortcode),
            notDeleted(inventoryEntry),
          ),
        ),
    },
    columns: {
      id: true,
      productId: true,
      ownershipMode: true,
      ownerLedgerPartyId: true,
    },
  });
  const trace = row
    ? (await loadInventoryOwnershipTraces(db, [row])).get(row.id)
    : undefined;
  const currentResolution = trace
    ? inventoryOwnerResolution(trace.ownership, trace.steps)
    : resolution;
  if (!currentResolution) return { steps: [], fallbackSource: null };
  return {
    currentResolution,
    steps: [
      ownershipSelfStep(currentResolution, trace?.intent),
      ...ownershipSteps(trace?.steps ?? []),
    ],
    fallbackSource: trace?.fallbackSource ?? null,
  };
}

/** Per-field ladders; every other resolved field gets the generic two-step chain. */
async function fieldSteps(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  resolution: FieldResolution,
): Promise<FieldSteps> {
  const plan = fieldEvidencePlan(entity, field);
  // A cached winner cannot select a row in the current acquisition ladder.
  if (plan?.kind === "ownership")
    return inventoryOwnershipFieldSteps(db, shortcode, resolution);
  if (resolution.evaluation) return evaluatedFieldSteps(entity, resolution);
  if (plan?.kind === "yield") {
    return {
      steps: [
        selfStep(entity, resolution),
        {
          title: "Recipe yield",
          ref: null,
          value: resolution.fallbackValue,
          assigned: resolution.fallbackValue !== null,
        },
      ],
      fallbackSource: null,
    };
  }
  if (plan?.kind === "policy") {
    const result = await unwrapDb(db).execute(
      sql`
      SELECT v.shortcode AS "vendorCode",${vendorItemizationPolicySql("v")} AS "vendorPolicy",
        c.shortcode AS "categoryCode",c."itemizationExpectation" AS "categoryPolicy"
      FROM "Purchase" p LEFT JOIN "Vendor" v ON v.id=p."vendorId" AND ${notDeleted("v")}
      LEFT JOIN "SpendingCategory" c ON c.id=p."spendingCategoryId" AND ${notDeleted("c")}
      WHERE p.shortcode=${shortcode} AND ${notDeleted("p")}`,
      "objects",
    );
    const row = z
      .object({
        vendorCode: z.string().nullable(),
        vendorPolicy: z.string().nullable(),
        categoryCode: z.string().nullable(),
        categoryPolicy: z.string().nullable(),
      })
      .optional()
      .parse(result[0]);
    const steps: Step[] = [
      selfStep(entity, resolution),
      ...(row?.vendorCode
        ? [
            {
              title: "Vendor policy",
              ref: { entityKind: "vendor" as const, entityId: row.vendorCode },
              value: row.vendorPolicy,
              assigned: row.vendorPolicy !== null,
            },
          ]
        : []),
      ...(row?.categoryCode
        ? [
            {
              title: "Spending category policy",
              ref: {
                entityKind: "spendingCategory" as const,
                entityId: row.categoryCode,
              },
              value: row.categoryPolicy,
              assigned: row.categoryPolicy !== null,
            },
          ]
        : []),
      {
        title: "Unclassified policy",
        ref: null,
        value: "unknown",
        assigned: true,
      },
    ];
    const fallback = steps.find((step) => !step.self && step.assigned);
    return {
      steps,
      fallbackSource: fallback?.ref ? { ...fallback.ref, name: null } : null,
    };
  }
  if (plan?.kind === "category")
    return expenseCategorySteps(db, shortcode, resolution);
  if (plan?.kind === "contextProject")
    return expenseProjectSteps(db, shortcode, resolution);
  if (plan?.kind === "contextTrade") {
    const inherited = await declaredInheritanceSteps(
      db,
      "project",
      shortcode,
      "defaultTrade",
      sql`(SELECT ${effectiveExpenseProjectSql("e")} FROM "Expense" e WHERE e.shortcode=${shortcode} AND ${notDeleted("e")})`,
    );
    const row = (
      await unwrapDb(db).execute(
        sql`SELECT p.shortcode,p."defaultTrade" AS trade FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND ${notDeleted("p")} WHERE e.shortcode=${shortcode} AND ${notDeleted("e")} AND e."lineKind"=${"principal"}`,
        "objects",
      )
    )[0];
    const purchase = z
      .object({ shortcode: z.string(), trade: z.string().nullable() })
      .safeParse(row);
    const purchaseSteps: Step[] = purchase.success
      ? [
          {
            title: "Purchase default",
            ref: { entityKind: "purchase", entityId: purchase.data.shortcode },
            value: purchase.data.trade,
            assigned: purchase.data.trade !== null,
          },
        ]
      : [];
    return {
      steps: [
        selfStep(entity, resolution),
        ...purchaseSteps,
        ...(inherited?.steps ?? []),
      ],
      fallbackSource:
        purchase.success && purchase.data.trade !== null
          ? {
              entityKind: "purchase",
              entityId: purchase.data.shortcode,
              name: null,
            }
          : (inherited?.fallbackSource ?? null),
    };
  }
  const declared = await declaredInheritanceSteps(db, entity, shortcode, field);
  if (declared) return declared;
  return {
    steps: [
      selfStep(entity, resolution),
      ...(resolution.sourceEntity || resolution.fallbackValue !== null
        ? [
            {
              title: humanize(resolution.source),
              ref: resolution.sourceEntity,
              value: resolution.fallbackValue,
              assigned: resolution.fallbackValue !== null,
            },
          ]
        : []),
    ],
    fallbackSource: resolution.sourceEntity,
  };
}

const CONTRIBUTOR_LIMIT = 20;

/** Shares come from the same rounded allocation relation as ledger totals. The
 * limit bounds both record evidence and subsequent ancestry reads; aggregate
 * outcomes are computed before the limit so omitted shares still count. */
async function allocatedExpenseEvidence(
  db: Database,
  shortcode: string,
  field: string,
  resolution: FieldResolution,
): Promise<{ evidence: Evidence; truncated: boolean }> {
  const selection = sql`ARRAY(SELECT id FROM "Expense" WHERE shortcode=${shortcode} AND ${notDeleted("Expense")})`;
  const value =
    field === "projectId"
      ? sql`to_jsonb(a."projectShortcode")`
      : field === "spendingCategoryId"
        ? sql`to_jsonb(a."spendingCategoryShortcode")`
        : field === "trade"
          ? sql`to_jsonb(a.trade)`
          : sql`to_jsonb(a."costType")`;
  const result = await unwrapDb(db).execute(
    sql`
    WITH shares AS (${expenseJointAllocationSql(selection)}), evidence AS (
      SELECT a.*,${value} AS value,e.shortcode,e.name,p.shortcode AS "purchaseCode",
        COALESCE(p."displayLabel",p."orderId") AS "purchaseName"
      FROM shares a LEFT JOIN "Expense" e ON e.id=a."principalExpenseId" AND ${notDeleted("e")}
      LEFT JOIN "Purchase" p ON p.id=a."purchaseId" AND ${notDeleted("p")}
    ) SELECT shortcode,name,"purchaseCode","purchaseName",value,"attributedCents",basis,incomplete,"categoryIncomplete",
      (SELECT count(*)::int FROM evidence) AS total,
      (SELECT count(DISTINCT value) FILTER (WHERE value <> 'null'::jsonb)::int FROM evidence) AS distinct_values
    FROM evidence ORDER BY shortcode NULLS LAST LIMIT ${CONTRIBUTOR_LIMIT + 1}`,
    "objects",
  );
  const rows = z
    .array(
      z.object({
        shortcode: z.string().nullable(),
        name: z.string().nullable(),
        purchaseCode: z.string().nullable(),
        purchaseName: z.string().nullable(),
        value: z.json(),
        attributedCents: z.string().nullable(),
        basis: z.string(),
        incomplete: z.boolean(),
        categoryIncomplete: z.boolean(),
        total: z.number(),
        distinct_values: z.number(),
      }),
    )
    .parse(result);
  const contributors: NonNullable<Evidence["contributors"]> = [];
  const codes = new Set<string>();
  for (const row of rows) collectCodes(row.value, codes);
  const labels = await shortcodeLabels(db, [...codes]);
  let truncated = rows.length > CONTRIBUTOR_LIMIT;
  for (const row of rows.slice(0, CONTRIBUTOR_LIMIT)) {
    let chain: Evidence["chain"] = {
      kind: "records",
      presentation: "timeline",
      rows: [],
      empty: "No principal line",
    };
    if (row.shortcode) {
      const principal = await readExpense(
        db,
        parseShortcodeFor("expense", row.shortcode),
      );
      const canonical = principal?.fieldResolutions?.[field];
      if (canonical) {
        const ladder = await fieldSteps(
          db,
          "expense",
          row.shortcode,
          field,
          canonical,
        );
        chain = await chainBlock(
          db,
          "expense",
          field,
          ladder.steps,
          winnerIndex(ladder.steps, canonical),
        );
        truncated ||= ladder.steps.length > 50;
      }
    }
    if (!row.shortcode) {
      chain.rows.push({
        entity: null,
        id: null,
        title:
          field === "projectId"
            ? "Purchase default project"
            : field === "costType"
              ? "Adjustment cost type"
              : "No principal line to inherit from",
        trailing: valueText(row.value, "expense", field, labels, undefined),
        state:
          row.value !== null
            ? { kind: "done", label: "Used" }
            : { kind: "skipped", label: "Not set" },
      });
    }
    contributors.push({
      chain: {
        ...chain,
        title: row.name ?? row.purchaseName ?? "Purchase default share",
        rows: [
          {
            entity: row.shortcode
              ? "expense"
              : row.purchaseCode
                ? "purchase"
                : null,
            id: row.shortcode ?? row.purchaseCode,
            title: row.name ?? row.purchaseName ?? "No principal line",
            trailing: valueText(row.value, "expense", field, labels, undefined),
            lines: [
              {
                text: `${row.attributedCents === null ? "Unpriced share" : formatCurrency(Number(row.attributedCents) / 100)}; ${row.basis} allocation basis${row.incomplete || row.categoryIncomplete ? "; incomplete evidence" : ""}`,
              },
            ],
          },
          ...chain.rows,
        ],
      },
    });
  }
  const distinct = rows[0]?.distinct_values ?? 0;
  return {
    evidence: {
      chain: {
        kind: "records",
        presentation: "timeline",
        rows: [],
        empty: "Follows contributing items",
        footer: `${rows[0]?.total ?? 0} allocation shares`,
      },
      contributors,
      fallbackSource: null,
      outcome:
        resolution.value !== null || distinct === 1
          ? "resolved"
          : distinct > 1
            ? "mixed"
            : "unset",
    },
    truncated,
  };
}

async function productPriceEvidence(
  db: Database,
  shortcode: string,
  resolution: FieldResolution,
): Promise<{ evidence: Evidence; truncated: boolean }> {
  const result = await unwrapDb(db).execute(
    sql`
    ${kitAncestorCteSql(sql`SELECT p.id,p.id,1::numeric,1::numeric,0 FROM "Product" p WHERE p.shortcode=${shortcode} AND ${notDeleted("p")}`)}
    SELECT e.shortcode,e.name,(e."costMinor"::float8 / 100) AS cost,e."productQuantity",p.shortcode AS "productCode",p.name AS "productName",
      ka."costWeight"::double precision AS "costWeight",ka."unitWeight"::double precision AS "unitWeight",ka.depth,
      count(*) OVER()::int AS total
    FROM kit_anc ka JOIN "Product" p ON p.id=ka."productId" AND ${notDeleted("p")}
    JOIN "Expense" e ON e."productId"=ka."productId" AND ${notDeleted("e")}
      AND ${sql.raw(actualExpenseSql("e"))} AND e."lineKind"=${sqlEnumConstant(expenseLineKindSchema, expenseLineKindSchema.enum.principal)} AND e."costMinor">0
    ORDER BY ka.depth,e.date DESC NULLS LAST,e.shortcode LIMIT ${CONTRIBUTOR_LIMIT + 1}`,
    "objects",
  );
  const rows = z
    .array(
      z.object({
        shortcode: z.string(),
        name: z.string().nullable(),
        cost: z.number(),
        productQuantity: z.number().nullable(),
        productCode: z.string(),
        productName: z.string(),
        costWeight: z.number(),
        unitWeight: z.number(),
        depth: z.number(),
        total: z.number(),
      }),
    )
    .parse(result);
  const steps: Step[] = [
    selfStep("product", resolution),
    {
      title: "Expense-derived unit price",
      ref: null,
      value: resolution.fallbackValue,
      assigned: resolution.fallbackValue !== null,
    },
  ];
  const contributors: NonNullable<Evidence["contributors"]> = rows
    .slice(0, CONTRIBUTOR_LIMIT)
    .map((row) => ({
      chain: {
        kind: "records",
        presentation: "timeline",
        title: row.name ?? "Acquisition",
        empty: "No price sample",
        rows: [
          {
            entity: "expense",
            id: row.shortcode,
            title: row.name ?? "Acquisition",
            trailing: row.productQuantity
              ? formatCurrency(
                  (row.cost * row.costWeight) /
                    (Math.abs(row.productQuantity) * row.unitWeight),
                )
              : row.productQuantity === 0
                ? "Cost only; zero units"
                : "Quantity unknown",
            state:
              row.productQuantity === null
                ? { kind: "skipped", label: "Quantity missing" }
                : { kind: "done", label: "Price sample" },
            lines: [
              {
                text:
                  row.productQuantity === null
                    ? "Excluded from the unit-price numerator and denominator"
                    : `Cost ${row.cost} × ${row.costWeight}; units ${Math.abs(row.productQuantity)} × ${row.unitWeight}`,
              },
            ],
          },
          {
            entity: "product",
            id: row.productCode,
            title: row.productName,
            trailing:
              row.depth === 0
                ? "Direct acquisition"
                : `Kit projection: ${row.depth} hops`,
            lines: [
              {
                text: "Blended acquisition cost divided by known units; the Product override wins over this fallback",
              },
            ],
          },
        ],
      },
    }));
  return {
    evidence: {
      chain: {
        ...(await chainBlock(
          db,
          "product",
          "price",
          steps,
          winnerIndex(steps, resolution),
        )),
        footer: `${rows[0]?.total ?? 0} acquisition contributions`,
      },
      contributors,
      fallbackSource: null,
      outcome: resolutionOutcome(steps, resolution),
    },
    truncated: rows.length > CONTRIBUTOR_LIMIT,
  };
}

async function transactionPolicyEvidence(
  db: Database,
  shortcode: string,
  resolution: FieldResolution,
): Promise<{ evidence: Evidence; truncated: boolean }> {
  const result = await unwrapDb(db).execute(
    sql`
    WITH policies AS (
      SELECT p.shortcode,COALESCE(p."displayLabel",p."orderId",p.shortcode) AS name,
        ${purchaseEvidenceFieldResolutionsSql("p")}->'itemizationExpectation' AS resolution
      FROM "FinancialTransaction" t
      JOIN "FinancialTransactionAllocation" a ON a."transactionId"=t.id AND ${notDeleted("a")}
      JOIN "Purchase" p ON p.id=a."purchaseId" AND ${notDeleted("p")}
      WHERE t.shortcode=${shortcode} AND ${notDeleted("t")}
    ) SELECT shortcode,name,resolution,count(*) OVER()::int AS total
    FROM policies ORDER BY shortcode LIMIT ${CONTRIBUTOR_LIMIT + 1}`,
    "objects",
  );
  const rows = z
    .array(
      z.object({
        shortcode: z.string(),
        name: z.string(),
        resolution: fieldResolutionSchema,
        total: z.number(),
      }),
    )
    .parse(result);
  const categoryResult = await unwrapDb(db).execute(
    sql`
    SELECT c.shortcode,c."itemizationExpectation" AS value,
      ${linkedPurchaseItemizationExpectationSql("t")} AS "linkedValue",
      ${linkedPurchaseItemizationSourceSql("t")} AS "linkedSource"
    FROM "FinancialTransaction" t
    LEFT JOIN "SpendingCategory" c ON c.id=t."spendingCategoryId" AND ${notDeleted("c")}
    WHERE t.shortcode=${shortcode} AND ${notDeleted("t")}`,
    "objects",
  );
  const category = z
    .object({
      shortcode: z.string().nullable(),
      value: itemizationExpectation.nullable(),
      linkedValue: itemizationExpectation.nullable(),
      linkedSource: fieldResolutionSchema.shape.sourceEntity,
    })
    .optional()
    .parse(categoryResult[0]);
  const linkedValue = category?.linkedValue ?? null;
  const steps: Step[] = [
    ...(resolution.mode === "allocated"
      ? [
          {
            title: "Reviewed reimbursement",
            ref: null,
            value: "not_expected",
            assigned: true,
          },
        ]
      : []),
    selfStep("financialTransaction", resolution),
    {
      title: "Linked Purchase policies",
      ref: category?.linkedSource ?? null,
      value: linkedValue,
      assigned: linkedValue !== null,
    },
    ...(category?.shortcode
      ? [
          {
            title: "Spending category policy",
            ref: {
              entityKind: "spendingCategory" as const,
              entityId: category.shortcode,
            },
            value: category.value,
            assigned: category.value !== null,
          },
        ]
      : []),
    {
      title: "Unclassified policy",
      ref: null,
      value: "unknown",
      assigned: true,
    },
  ];
  const contributors: NonNullable<Evidence["contributors"]> = [];
  for (const row of rows.slice(0, CONTRIBUTOR_LIMIT)) {
    const ladder = await fieldSteps(
      db,
      "purchase",
      row.shortcode,
      "itemizationExpectation",
      row.resolution,
    );
    const chain = await chainBlock(
      db,
      "purchase",
      "itemizationExpectation",
      ladder.steps,
      winnerIndex(ladder.steps, row.resolution),
    );
    contributors.push({
      chain: {
        ...chain,
        title: row.name,
        rows: [
          {
            entity: "purchase",
            id: row.shortcode,
            title: row.name,
            trailing: valueText(
              row.resolution.value,
              "purchase",
              "itemizationExpectation",
              new Map(),
              undefined,
            ),
          },
          ...chain.rows,
        ],
      },
    });
  }
  const fallback = steps.find((step) => !step.self && step.assigned);
  return {
    evidence: {
      chain: await chainBlock(
        db,
        "financialTransaction",
        "itemizationExpectation",
        steps,
        winnerIndex(steps, resolution),
      ),
      contributors,
      fallbackSource: fallback?.ref ? { ...fallback.ref, name: null } : null,
      // Different Purchase policies are inputs to an ordered aggregate (required,
      // unknown, not_expected), rather than a mixed scalar resolution.
      outcome: "resolved",
    },
    truncated: rows.length > CONTRIBUTOR_LIMIT,
  };
}

/**
 * A Product's Owner rollup, one row per live Inventory entry (its location,
 * owner, and whether that owner is set or only inherited); a Product with no
 * entries shows the acquisition ladder an `inherit` entry would follow.
 */
async function productOwnersEvidence(
  db: Database,
  shortcode: string,
): Promise<{ evidence: Evidence; truncated: boolean }> {
  const productId = (
    await getDb(db).query.product.findFirst({
      where: {
        RAW: (table, { and: both, eq: equals, isNull }) =>
          relationalSql(
            table,
            both(equals(table.shortcode, shortcode), isNull(table.deletedAt)),
          ),
      },
      columns: { id: true },
    })
  )?.id;
  if (!productId)
    return {
      evidence: {
        chain: {
          kind: "records",
          presentation: "timeline",
          rows: [],
          empty: "No owner",
        },
        fallbackSource: null,
        outcome: "unset",
      },
      truncated: false,
    };
  const entries = await getDb(db)
    .select({
      id: inventoryEntry.id,
      shortcode: inventoryEntry.shortcode,
      productId: inventoryEntry.productId,
      ownershipMode: inventoryEntry.ownershipMode,
      ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
      locationName: location.name,
    })
    .from(inventoryEntry)
    .innerJoin(location, eq(location.id, inventoryEntry.locationId))
    .where(
      and(eq(inventoryEntry.productId, productId), notDeleted(inventoryEntry)),
    )
    .orderBy(location.name, inventoryEntry.shortcode);
  if (entries.length === 0) {
    const steps = (await loadInheritedProductSteps(db, [productId])).get(
      productId,
    );
    const ladder = ownershipSteps(steps ?? []);
    const evidence = await evidenceBlock(
      db,
      "inventory",
      "ownerLedgerPartyId",
      ladder,
      ladder.findIndex((step) => step.assigned),
      steps?.find((step) => step.decides)?.ref
        ? { ...steps.find((step) => step.decides)!.ref!, name: null }
        : null,
    );
    evidence.outcome = ladder.some((step) => step.assigned)
      ? "resolved"
      : "unset";
    evidence.chain.title = "Acquisition owner context";
    evidence.chain.footer =
      "No live inventory entries. This is the owner context a new inheriting entry would use.";
    evidence.branches = coverage(0, 0);
    return { evidence, truncated: isTruncated(evidence) };
  }

  const visible = entries.slice(0, 50);
  const traces = await loadInventoryOwnershipTraces(db, visible);
  const evaluated = new Map(
    [...traces].map(([id, trace]) => {
      const resolution = inventoryOwnerResolution(trace.ownership, trace.steps);
      return [
        id,
        {
          resolution,
          steps: [
            ownershipSelfStep(resolution, trace.intent),
            ...ownershipSteps(trace.steps),
          ],
        },
      ] as const;
    }),
  );
  const labels = await labelsForSteps(
    db,
    [...evaluated.values()].flatMap((entry) => entry.steps),
  );
  const contributors: NonNullable<Evidence["contributors"]> = [];
  const resolvedValues = new Set<string>();
  const unresolvedOwner =
    entityFieldModels.inventory.fields.find(
      (field) => field.key === "ownerLedgerPartyId",
    )?.resolution?.labels?.unresolved ?? "Unknown";
  for (const entry of visible) {
    const ownership = traces.get(entry.id)?.ownership;
    const owner = ownership?.effectiveOwner?.name;
    const inherited = ownership?.mode === "inherit";
    const trace = traces.get(entry.id);
    if (!trace || !ownership) continue;
    const meaningfulNull =
      ownership.mode !== "inherit" ||
      trace.steps.some((step) => step.decides && step.ref !== null);
    resolvedValues.add(
      ownership.effectiveOwner?.id ??
        (meaningfulNull
          ? ownership.mode === "inherit"
            ? "No single owner"
            : "Household"
          : unresolvedOwner),
    );
    const { resolution, steps } = evaluated.get(entry.id)!;
    const branch = {
      entityKind: "inventory" as const,
      entityId: entry.shortcode,
    };
    const detail = await evidenceBlock(
      db,
      "inventory",
      "ownerLedgerPartyId",
      steps.map((step) => ({ ...step, branch })),
      winnerIndex(steps, resolution),
      trace.fallbackSource,
      labels,
    );
    const chain = detail.chain;
    const summary: ReportRecordRow = {
      entity: "inventory",
      id: parseShortcodeFor("inventory", entry.shortcode),
      title: entry.locationName,
      trailing:
        owner ??
        (inherited
          ? meaningfulNull
            ? "No single owner"
            : unresolvedOwner
          : "Household"),
      state: inherited
        ? { kind: "not_reached", label: "Inherited" }
        : { kind: "done", label: "Set here" },
    };
    contributors.push({
      chain: {
        ...chain,
        title: entry.locationName,
        rows: [summary, ...chain.rows],
      },
      steps: detail.steps?.map((step) => ({
        ...step,
        rowIndex: step.rowIndex + 1,
      })),
      coverage: detail.coverage,
    });
  }

  return {
    evidence: {
      chain: {
        kind: "records",
        presentation: "timeline",
        title: "Owners by inventory entry",
        rows: [],
        empty: "",
      },
      contributors,
      branches: coverage(entries.length, visible.length),
      fallbackSource: null,
      ...(resolvedValues.size > 1
        ? { outcome: "mixed" as const }
        : entries.length > visible.length
          ? {}
          : {
              outcome: resolvedValues.has(unresolvedOwner)
                ? ("unset" as const)
                : ("resolved" as const),
            }),
    },
    truncated:
      entries.length > visible.length ||
      contributors.some(
        (block) =>
          (block.coverage?.omitted ?? 0) > 0 ||
          block.steps?.some((step) => (step.coverage?.omitted ?? 0) > 0),
      ),
  };
}
/** Lazy evidence is loaded on the same snapshot as the authoritative resolution. */
export async function loadFieldResolutionEvidence(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  resolution: FieldResolution | null,
): Promise<{ evidence: Evidence | null; truncated: boolean }> {
  const plan = fieldEvidencePlan(entity, field);
  if (plan?.kind === "owners") return productOwnersEvidence(db, shortcode);
  // A selected-record explanation can run before the ownership snapshot is
  // published. Load its exact current ladder here, never on ordinary list reads.
  const prepared =
    !resolution && plan?.kind === "ownership"
      ? await inventoryOwnershipFieldSteps(db, shortcode, null)
      : undefined;
  resolution ??= prepared?.currentResolution ?? null;
  if (!resolution) return { evidence: null, truncated: false };
  if (plan?.kind === "price")
    return productPriceEvidence(db, shortcode, resolution);
  if (plan?.kind === "policyAggregate")
    return transactionPolicyEvidence(db, shortcode, resolution);
  if (plan?.allocated && resolution.mode === "allocated")
    return allocatedExpenseEvidence(db, shortcode, field, resolution);
  const { steps, fallbackSource, currentResolution } =
    prepared ?? (await fieldSteps(db, entity, shortcode, field, resolution));
  const evidence = await evidenceBlock(
    db,
    entity,
    field,
    steps,
    winnerIndex(steps, currentResolution ?? resolution),
    fallbackSource,
  );
  evidence.outcome = resolutionOutcome(steps, currentResolution ?? resolution);
  return { evidence, truncated: isTruncated(evidence) };
}
