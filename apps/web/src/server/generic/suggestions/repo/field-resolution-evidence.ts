import { type Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type {
  FieldDecisionStep,
  FieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import {
  fieldResolutionSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import { humanize, parseShortcode } from "@cubby/shared";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { formatCurrency } from "~/lib/number-format";
import type { Database } from "~/server/db";
import {
  effectiveFieldSql,
  hierarchyInheritance,
  inheritanceLadderSql,
} from "~/server/db/computed/effective-field";
import {
  getDb,
  notDeleted,
  unwrapDb,
  sqlEnumConstant,
} from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
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
import { shortcodeLabels } from "~/server/generic/shortcode/repo/shortcode-labels";

type Evidence = NonNullable<FieldExplanationOutput["resolutionEvidence"]>;
type Json = z.infer<ReturnType<typeof z.json>>;
type Ref = Pick<
  NonNullable<Evidence["fallbackSource"]>,
  "entityKind" | "entityId"
>;

const nodeSchema = z.object({
  shortcode: z.string(),
  name: z.string(),
  depth: z.number(),
  value: z.json(),
  assigned: z.boolean(),
  /** False at the ancestor a `whileSame` walk stops at, the last listed. */
  eligible: z.boolean(),
});
type Node = z.infer<typeof nodeSchema>;
type AncestryKind = "project" | "task" | "productCategory";

/** One place a value could come from, before its role in the chain is known. */
type Step = {
  title: string;
  ref: Ref | null;
  value: Json;
  assigned: boolean;
  /** Supplies the value when no source entity identifies the winner. */
  self?: boolean;
  /** What an assigned null means at this step, over the field's None label. */
  nullLabel?: string;
  unavailableReason?: string;
  decision?: Pick<
    FieldDecisionStep,
    "source" | "reason" | "effect" | "observed"
  >;
  branch?: FieldDecisionStep["branch"];
  lines?: ReportRecordRow["lines"];
};

const source = (kind: AncestryKind, node: Node | undefined) =>
  node ? { entityKind: kind, entityId: node.shortcode, name: node.name } : null;

/**
 * The places a hierarchy value could come from, the record first, with each
 * one's own value and whether it decides. A declared chain
 * (`resolution.inherit`) reads the generator's ladder, so the explanation
 * walks exactly what the value walks.
 */
async function ancestors(
  db: Database,
  kind: AncestryKind,
  start: SQL,
  field: string,
): Promise<Node[]> {
  const table = sql.identifier(
    kind === "project"
      ? "Project"
      : kind === "task"
        ? "Task"
        : "ProductCategory",
  );
  // Project trade explanations read the project default trade.
  const chainField =
    kind === "project" && field === "trade" ? "defaultTrade" : field;
  const declared = hierarchyInheritance(kind, chainField);
  if (declared === null)
    throw new Error(`${kind}.${field} declares no hierarchy inheritance`);
  const target =
    declared.reference === null ? null : entityManifest[declared.reference];
  const shown =
    kind === "productCategory" && chainField === "spendingCategoryId"
      ? // The mapping shows its mode beside the category, so a block reads as one.
        sql`jsonb_build_object('mode',p."spendingCategoryMode",'category',(SELECT c.shortcode FROM "SpendingCategory" c WHERE c.id=l.value AND ${notDeleted("c")}))`
      : target?.dbTable
        ? sql`to_jsonb((SELECT c.shortcode FROM ${sql.identifier(target.dbTable)} c WHERE c.id=l.value${target.softDelete ? sql` AND ${notDeleted("c")}` : sql``}))`
        : sql`to_jsonb(l.value)`;
  const rows = await unwrapDb(db).execute(sql`
    SELECT p.shortcode,p.name,${shown} AS value,l.decides AS assigned,l.depth,l.eligible
    FROM ${inheritanceLadderSql(kind, chainField, start)} l JOIN ${table} p ON p.id=l.id
    ORDER BY l.depth`);
  return z.array(nodeSchema).parse(rows.rows);
}

const nodeSteps = (
  kind: AncestryKind,
  nodes: Node[],
  subject: { entity: Entity; id: string },
): Step[] =>
  nodes.map((node) => {
    const self = subject.entity === kind && node.shortcode === subject.id;
    return {
      title: self ? thisRecord(subject.entity) : node.name,
      ref: self ? null : { entityKind: kind, entityId: node.shortcode },
      value: node.value,
      assigned: node.assigned,
      self,
    };
  });

const thisRecord = (entity: Entity) =>
  `This ${entitySummary[entity].singular.toLowerCase()}`;

/** The subject's own stored intent, first in every chain it is not part of. */
const selfStep = (entity: Entity, resolution: FieldResolution): Step => ({
  title: thisRecord(entity),
  ref: null,
  value: resolution.storedValue,
  assigned:
    resolution.mode === "explicit" ||
    (resolution.mode === "none" && resolution.canReset) ||
    (resolution.mode === "allocated" && resolution.storedValue !== null),
  self: true,
  ...(entity === "inventory" ? { nullLabel: "Household" } : {}),
});

const OWNERSHIP_STEP_TITLES = {
  acquisition: "Acquisition context",
  inherited_beneficiary: "Purchase beneficiary",
  inherited_vendor_account: "Vendor account default",
  inherited_payment_account: "Payment account default",
} as const;

const DECISION_REASONS = {
  assigned: "A value is assigned at this source.",
  not_set: "No value is assigned at this source; continue to the next source.",
  explicit:
    "The individual owner is set on this inventory entry and overrides acquisition defaults.",
  household:
    "This inventory entry explicitly records Household stock, with no individual owner.",
  inherit:
    "This inventory entry inherits its owner from current acquisition evidence.",
  acquisition_absent:
    "No applicable acquisition is recorded. Inherited ownership is unknown.",
  acquisition_multiple:
    "Multiple distinct acquisitions are recorded. They cannot supply one inherited owner.",
  acquisition_single:
    "Exactly one applicable acquisition supplies the ownership context. Only acquisition lines count; funders and purchasers do not establish ownership.",
  beneficiary_absent:
    "No beneficiary attribution is recorded on the applicable acquisition lines; account defaults may apply.",
  beneficiary_unknown:
    "All beneficiary shares have unknown parties; no ownership decision is recorded, so account defaults may apply.",
  beneficiary_incomplete:
    "Some applicable acquisition lines lack beneficiary attribution. Incomplete coverage blocks account defaults.",
  beneficiary_split:
    "An applicable acquisition line has split beneficiary attribution. It cannot establish a single owner and blocks account defaults.",
  beneficiary_unresolved:
    "Some beneficiary attribution names an individual while another share has no resolved party. Partial attribution blocks account defaults.",
  beneficiary_not_individual:
    "A beneficiary party is unavailable or is not a live member or guest. It cannot establish an individual owner and blocks account defaults.",
  beneficiary_conflict:
    "The applicable acquisition lines name different beneficiaries. Conflicting evidence blocks account defaults.",
  beneficiary_agreement:
    "Every applicable acquisition line wholly names the same live member or guest as beneficiary.",
  vendor_absent:
    "No live vendor account default is available; payment account defaults may apply.",
  vendor_disabled:
    "The vendor account's inventory owner default is off. Its associated party does not supply an owner; payment defaults may apply.",
  vendor_unusable:
    "The vendor account's inventory owner default is on, but its associated party is not a live member or guest. This blocks payment account fallback.",
  vendor_enabled:
    "The vendor account's inventory owner default is on and its associated party is a live member or guest.",
  payment_absent:
    "No qualifying positive payment allocation from a live account is recorded. Inherited ownership remains unknown.",
  payment_disabled:
    "At least one qualifying payment account has its inventory owner default off. Every payment must be enabled and agree on an individual party.",
  payment_unresolved:
    "At least one qualifying payment account has no resolved party. Account holders alone do not establish ownership.",
  payment_not_individual:
    "At least one qualifying payment account's party is unavailable or is not a live member or guest.",
  payment_conflict:
    "The qualifying payment accounts name different individual parties. They cannot establish a single owner.",
  payment_agreement:
    "Every qualifying payment account has its inventory owner default on and all name the same live member or guest.",
} satisfies Record<FieldDecisionStep["reason"], string>;

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

async function taskAssigneeSteps(
  db: Database,
  shortcode: string,
): Promise<FieldSteps> {
  const entity = "task";
  const field = "assigneeId";
  const subject = { entity, id: shortcode } as const;

  // `resolution.inherit`: the nearest ancestor task that sets its own
  // assignee, then the task's effective project default.
  const tasks = await ancestors(
    db,
    "task",
    sql`(SELECT id FROM "Task" WHERE shortcode=${shortcode} AND ${notDeleted("Task")})`,
    field,
  );
  const projects = await ancestors(
    db,
    "project",
    sql`(SELECT ${effectiveFieldSql("task", "projectId", "t")} FROM "Task" t WHERE t.shortcode=${shortcode} AND ${notDeleted("t")})`,
    field,
  );
  const nobody = (steps: Step[]) =>
    steps.map((step) => ({ ...step, nullLabel: "Nobody" }));
  const ancestor = tasks.find((node) => node.depth > 0 && node.assigned);
  return {
    steps: [
      ...nobody(nodeSteps("task", tasks, subject)),
      ...nobody(nodeSteps("project", projects, subject)),
    ],
    fallbackSource: ancestor
      ? source("task", ancestor)
      : source(
          "project",
          projects.find((node) => node.assigned),
        ),
  };
}

async function expenseProjectSteps(
  db: Database,
  shortcode: string,
  resolution: FieldResolution,
): Promise<FieldSteps> {
  const entity = "expense";

  const result = await unwrapDb(db).execute(sql`
      SELECT p.shortcode AS "purchaseCode",pc.shortcode AS "purchaseProject",
        hp.shortcode AS "foodProject",hp.name AS "foodName",e."lineKind"
      FROM "Expense" e
      LEFT JOIN "Purchase" p ON p.id=e."purchaseId" AND ${notDeleted("p")}
      LEFT JOIN "Project" pc ON pc.id=p."defaultProjectId" AND ${notDeleted("pc")}
      CROSS JOIN LATERAL (SELECT e."lineKind",e."productId",NULL::uuid AS "projectId",NULL::uuid AS "purchaseId") food_candidate
      LEFT JOIN "Project" hp ON hp.id=${effectiveExpenseProjectSql("food_candidate")} AND ${notDeleted("hp")}
      WHERE e.shortcode=${shortcode} AND ${notDeleted("e")}`);
  const row = z
    .object({
      purchaseCode: z.string().nullable(),
      purchaseProject: z.string().nullable(),
      foodProject: z.string().nullable(),
      foodName: z.string().nullable(),
      lineKind: z.string(),
    })
    .optional()
    .parse(result.rows[0]);
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
    where: and(
      eq(inventoryEntry.shortcode, shortcode),
      notDeleted(inventoryEntry),
    ),
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
  const subject = { entity, id: shortcode };
  // A cached winner cannot select a row in the current acquisition ladder.
  if (entity === "inventory" && field === "ownerLedgerPartyId")
    return inventoryOwnershipFieldSteps(db, shortcode, resolution);
  if (resolution.evaluation) return evaluatedFieldSteps(entity, resolution);
  if (entity === "recipe" && field === "servings") {
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
  if (entity === "purchase" && field === "itemizationExpectation") {
    const result = await unwrapDb(db).execute(sql`
      SELECT v.shortcode AS "vendorCode",${vendorItemizationPolicySql("v")} AS "vendorPolicy",
        c.shortcode AS "categoryCode",c."itemizationExpectation" AS "categoryPolicy"
      FROM "Purchase" p LEFT JOIN "Vendor" v ON v.id=p."vendorId" AND ${notDeleted("v")}
      LEFT JOIN "SpendingCategory" c ON c.id=p."spendingCategoryId" AND ${notDeleted("c")}
      WHERE p.shortcode=${shortcode} AND ${notDeleted("p")}`);
    const row = z
      .object({
        vendorCode: z.string().nullable(),
        vendorPolicy: z.string().nullable(),
        categoryCode: z.string().nullable(),
        categoryPolicy: z.string().nullable(),
      })
      .optional()
      .parse(result.rows[0]);
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
  if (entity === "task" && field === "assigneeId")
    return taskAssigneeSteps(db, shortcode);
  if (entity === "expense" && field === "spendingCategoryId")
    return expenseCategorySteps(db, shortcode, resolution);
  if (entity === "expense" && field === "projectId")
    return expenseProjectSteps(db, shortcode, resolution);
  if (entity === "expense" && field === "trade") {
    const nodes = await ancestors(
      db,
      "project",
      sql`(SELECT ${effectiveExpenseProjectSql("e")} FROM "Expense" e WHERE e.shortcode=${shortcode} AND ${notDeleted("e")})`,
      field,
    );
    const row = (
      await unwrapDb(db).execute(
        sql`SELECT p.shortcode,p."defaultTrade" AS trade FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND ${notDeleted("p")} WHERE e.shortcode=${shortcode} AND ${notDeleted("e")} AND e."lineKind"=${"principal"}`,
      )
    ).rows[0];
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
        ...nodeSteps("project", nodes, subject),
      ],
      fallbackSource:
        purchase.success && purchase.data.trade !== null
          ? {
              entityKind: "purchase",
              entityId: purchase.data.shortcode,
              name: null,
            }
          : source(
              "project",
              nodes.find((node) => node.assigned),
            ),
    };
  }
  if (
    entity === "project" &&
    ["defaultTrade", "locations", "assigneeId"].includes(field)
  ) {
    const nodes = await ancestors(
      db,
      "project",
      sql`(SELECT id FROM "Project" WHERE shortcode=${shortcode} AND ${notDeleted("Project")})`,
      field,
    );
    return {
      steps: nodeSteps("project", nodes, subject),
      fallbackSource: source(
        "project",
        nodes.find((node) => node.depth > 0 && node.assigned),
      ),
    };
  }
  if (
    entity === "task" &&
    ["trade", "projectId", "subjectProductId"].includes(field)
  ) {
    const nodes = await ancestors(
      db,
      "task",
      sql`(SELECT id FROM "Task" WHERE shortcode=${shortcode} AND ${notDeleted("Task")})`,
      field,
    );
    let fallbackSource = source(
      "task",
      nodes.find((node) => node.depth > 0 && node.assigned && node.eligible),
    );
    const steps = nodeSteps("task", nodes, subject);
    // An ancestor on another effective Project is inspected but never
    // eligible (trade's `whileSame` walk).
    for (const [index, node] of nodes.entries()) {
      const step = steps[index];
      if (step && node.assigned && !node.eligible)
        step.unavailableReason = "Different effective Project";
    }
    if (field === "trade") {
      const projects = await ancestors(
        db,
        "project",
        sql`(SELECT ${effectiveFieldSql("task", "projectId", "t")} FROM "Task" t WHERE t.shortcode=${shortcode} AND ${notDeleted("t")})`,
        "defaultTrade",
      );
      fallbackSource ??= source(
        "project",
        projects.find((node) => node.assigned),
      );
      steps.push(...nodeSteps("project", projects, subject));
    }
    return { steps, fallbackSource };
  }
  if (
    entity === "productCategory" &&
    ["spendingCategoryId", "effectiveSpendingCategory", "feature"].includes(
      field,
    )
  ) {
    const nodes = await ancestors(
      db,
      "productCategory",
      sql`(SELECT id FROM "ProductCategory" WHERE shortcode=${shortcode} AND ${notDeleted("ProductCategory")})`,
      field === "feature" ? "feature" : "spendingCategoryId",
    );
    return {
      steps: nodeSteps("productCategory", nodes, subject),
      fallbackSource: source(
        "productCategory",
        nodes.find((node) => node.depth > 0 && node.assigned),
      ),
    };
  }
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

/** The step that supplies the value: the subject's own for explicit/none,
 * otherwise the resolution's source record, else the first assigned step
 * after the subject (sources outside the ladder are appended). */
function winnerIndex(
  steps: readonly Step[],
  resolution: FieldResolution,
): number {
  if (
    resolution.mode === "explicit" ||
    (resolution.mode === "none" && resolution.canReset)
  )
    return steps.findIndex((step) => step.self);
  const id = resolution.sourceEntity?.entityId;
  const byRef = id
    ? steps.findIndex(
        (step) =>
          step.ref?.entityId === id && step.assigned && !step.unavailableReason,
      )
    : -1;
  if (byRef >= 0) return byRef;
  if (resolution.value === null)
    return steps.findIndex(
      (step) =>
        !step.self &&
        step.assigned &&
        !step.unavailableReason &&
        step.nullLabel !== undefined,
    );
  return steps.findIndex(
    (step) => !step.self && step.assigned && !step.unavailableReason,
  );
}

const SPENDING_BINDING = z.object({
  mode: z.string(),
  category: z.string().nullable(),
});

/** A stored value as words: record codes become their labels, enums their
 * option labels, spending bindings their category (or "Blocked"). */
function valueText(
  value: Json,
  entity: Entity,
  field: string,
  labels: Map<string, string>,
  noneLabel: string | undefined,
): string {
  if (value === null) return noneLabel ?? "Not set";
  const binding = SPENDING_BINDING.safeParse(value);
  if (binding.success)
    return binding.data.mode === "blocked"
      ? "Blocked"
      : valueText(binding.data.category, entity, field, labels, noneLabel);
  if (Array.isArray(value))
    return value.length === 0
      ? (noneLabel ?? "None")
      : value
          .map((item) => valueText(item, entity, field, labels, noneLabel))
          .join(", ");
  if (typeof value === "string") {
    const code = parseShortcode(value);
    if (code) return labels.get(code.shortcode) ?? code.shortcode;
    const model = entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === field,
    );
    const option = (
      model?.control?.options ??
      model?.display.valueOptions ??
      []
    ).find((candidate) => candidate.value === value);
    return option?.label ?? humanize(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

const collectCodes = (value: Json, into: Set<string>) => {
  if (typeof value === "string") {
    const code = parseShortcode(value);
    if (code) into.add(code.shortcode);
  } else if (Array.isArray(value))
    for (const item of value) collectCodes(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectCodes(item ?? null, into);
};

async function labelsForSteps(db: Database, steps: readonly Step[]) {
  const codes = new Set<string>();
  for (const step of steps) {
    collectCodes(step.value, codes);
    for (const observation of step.decision?.observed ?? []) {
      if (observation.entity) codes.add(observation.entity.entityId);
      collectCodes(observation.value, codes);
    }
  }
  return shortcodeLabels(db, [...codes]);
}

async function chainBlock(
  db: Database,
  entity: Entity,
  field: string,
  steps: Step[],
  winner: number,
  loadedLabels?: Map<string, string>,
): Promise<Evidence["chain"]> {
  const labels = loadedLabels ?? (await labelsForSteps(db, steps));
  const model = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  );
  const resolution:
    | EntityFieldModel["fields"][number]["resolution"]
    | undefined = model?.resolution;
  const noneLabel = resolution?.labels?.none;
  const rows: ReportRecordRow[] = steps
    .slice(0, MAX_CHAIN_ROWS)
    .map((step, index) => {
      const effect = step.decision?.effect;
      const state: NonNullable<ReportRecordRow["state"]> =
        step.unavailableReason
          ? { kind: "skipped", label: step.unavailableReason }
          : effect === "used"
            ? { kind: "done", label: "Used" }
            : effect === "blocked"
              ? { kind: "skipped", label: "Blocks fallback" }
              : effect === "overridden"
                ? { kind: "skipped", label: "Evaluated · overridden" }
                : effect === "context"
                  ? { kind: "done", label: "Context" }
                  : effect === "fallback"
                    ? { kind: "skipped", label: "Continue" }
                    : index === winner
                      ? { kind: "done", label: "Used" }
                      : !step.assigned
                        ? { kind: "skipped", label: "Not set" }
                        : winner >= 0 && index > winner
                          ? { kind: "skipped", label: "Evaluated · overridden" }
                          : { kind: "skipped", label: "Not used" };
      return {
        entity: step.ref?.entityKind ?? null,
        id: step.ref?.entityId ?? null,
        title: step.title,
        lines: step.decision
          ? [
              { text: DECISION_REASONS[step.decision.reason], tone: "muted" },
              ...step.decision.observed.flatMap((observation) => {
                const text = observationText(observation, labels);
                return text ? [{ text, tone: "muted" as const }] : [];
              }),
            ]
          : [
              {
                text: step.assigned
                  ? DECISION_REASONS.assigned
                  : DECISION_REASONS.not_set,
                tone: "muted",
              },
            ],
        trailing:
          step.decision?.source === "acquisition"
            ? null
            : step.assigned
              ? valueText(
                  step.value,
                  entity,
                  field,
                  labels,
                  step.nullLabel ?? noneLabel,
                )
              : null,
        state,
      };
    });
  return {
    kind: "records",
    presentation: "timeline",
    rows,
    empty: "Nothing to inherit from",
  };
}

const coverage = (total: number, shown: number) => ({
  total,
  shown,
  omitted: total - shown,
});
const MAX_CHAIN_ROWS = 50;
const MAX_OBSERVATIONS = 50;

function observationText(
  observation: FieldDecisionStep["observed"][number],
  labels: Map<string, string>,
): string | null {
  const value = observation.value;
  const record =
    value !== null && !Array.isArray(value) && typeof value === "object"
      ? value
      : null;
  const party = record?.party;
  const partyRecord =
    party !== null && !Array.isArray(party) && typeof party === "object"
      ? party
      : null;
  const ref = observation.entity
    ? ` (${labels.get(observation.entity.entityId) ?? observation.entity.entityId})`
    : "";
  if (record && typeof record.inventoryOwnerDefaultEnabled === "boolean") {
    return `${observation.label}${ref}: inventory owner default ${record.inventoryOwnerDefaultEnabled ? "on" : "off"}; associated party: ${partyRecord?.name ?? "Unresolved"}${partyRecord?.kind ? ` (${partyRecord.kind})` : ""}${record.allocationAmount !== undefined ? `; allocation ${record.allocationAmount}` : ""}`;
  }
  if (record && Array.isArray(record.beneficiaries)) {
    const beneficiaries = record.beneficiaries.map((value) => {
      if (value === null || Array.isArray(value) || typeof value !== "object")
        return "Unresolved party";
      const party = value.party;
      return `${party && !Array.isArray(party) && typeof party === "object" ? `${party.name} (${party.kind})` : "Unresolved party"}; weight ${value.weight}`;
    });
    return `${observation.label}${ref}: ${beneficiaries.length ? beneficiaries.join("; ") : "No beneficiary attribution"}`;
  }
  return null;
}

async function evidenceBlock(
  db: Database,
  entity: Entity,
  field: string,
  allSteps: Step[],
  winner: number,
  fallbackSource: Evidence["fallbackSource"],
  loadedLabels?: Map<string, string>,
): Promise<Evidence> {
  const steps = allSteps.slice(0, MAX_CHAIN_ROWS).map((step) =>
    step.decision
      ? {
          ...step,
          decision: {
            ...step.decision,
            observed: step.decision.observed.slice(0, MAX_OBSERVATIONS),
          },
        }
      : step,
  );
  const chain = await chainBlock(
    db,
    entity,
    field,
    steps,
    winner,
    loadedLabels,
  );
  const omittedObservations = allSteps
    .slice(0, steps.length)
    .reduce(
      (count, step) =>
        count +
        Math.max(0, (step.decision?.observed.length ?? 0) - MAX_OBSERVATIONS),
      0,
    );
  if (allSteps.length > steps.length || omittedObservations > 0)
    chain.footer = `${steps.length} of ${allSteps.length} decision steps shown; ${omittedObservations} observations omitted.`;
  return {
    chain,
    fallbackSource,
    coverage: coverage(allSteps.length, steps.length),
    steps: steps.map((step, rowIndex) => ({
      ...(step.decision ?? {
        source: step.ref?.entityKind ?? "self",
        reason: step.assigned ? ("assigned" as const) : ("not_set" as const),
        effect:
          rowIndex === winner
            ? ("used" as const)
            : !step.assigned
              ? ("fallback" as const)
              : winner >= 0 && rowIndex > winner
                ? ("overridden" as const)
                : ("context" as const),
        observed: [
          {
            label: step.title,
            entity: step.ref
              ? { entityKind: step.ref.entityKind, entityId: step.ref.entityId }
              : null,
            value: step.value,
          },
        ],
      }),
      rowIndex,
      ...(step.branch ? { branch: step.branch } : {}),
      ...(step.decision
        ? {
            coverage: coverage(
              allSteps[rowIndex]!.decision!.observed.length,
              step.decision.observed.length,
            ),
          }
        : {}),
    })),
  };
}

const isTruncated = (evidence: Evidence) =>
  (evidence.coverage?.omitted ?? 0) > 0 ||
  (evidence.branches?.omitted ?? 0) > 0 ||
  evidence.steps?.some((step) => (step.coverage?.omitted ?? 0) > 0) === true;
function resolutionOutcome(
  steps: Step[],
  resolution: FieldResolution,
): NonNullable<Evidence["outcome"]> {
  const winner = winnerIndex(steps, resolution);
  const binding = SPENDING_BINDING.safeParse(steps[winner]?.value);
  if (binding.success && binding.data.mode === "blocked") return "blocked";
  return resolution.value !== null || winner >= 0 ? "resolved" : "unset";
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
  const result = await unwrapDb(db).execute(sql`
    WITH shares AS (${expenseJointAllocationSql(selection)}), evidence AS (
      SELECT a.*,${value} AS value,e.shortcode,e.name,p.shortcode AS "purchaseCode",
        COALESCE(p."displayLabel",p."orderId") AS "purchaseName"
      FROM shares a LEFT JOIN "Expense" e ON e.id=a."principalExpenseId" AND ${notDeleted("e")}
      LEFT JOIN "Purchase" p ON p.id=a."purchaseId" AND ${notDeleted("p")}
    ) SELECT shortcode,name,"purchaseCode","purchaseName",value,"attributedCents",basis,incomplete,"categoryIncomplete",
      (SELECT count(*)::int FROM evidence) AS total,
      (SELECT count(DISTINCT value) FILTER (WHERE value <> 'null'::jsonb)::int FROM evidence) AS distinct_values
    FROM evidence ORDER BY shortcode NULLS LAST LIMIT ${CONTRIBUTOR_LIMIT + 1}`);
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
    .parse(result.rows);
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
  const result = await unwrapDb(db).execute(sql`
    ${kitAncestorCteSql(sql`SELECT p.id,p.id,1::numeric,1::numeric,0 FROM "Product" p WHERE p.shortcode=${shortcode} AND ${notDeleted("p")}`)}
    SELECT e.shortcode,e.name,e.cost,e."productQuantity",p.shortcode AS "productCode",p.name AS "productName",
      ka."costWeight"::double precision AS "costWeight",ka."unitWeight"::double precision AS "unitWeight",ka.depth,
      count(*) OVER()::int AS total
    FROM kit_anc ka JOIN "Product" p ON p.id=ka."productId" AND ${notDeleted("p")}
    JOIN "Expense" e ON e."productId"=ka."productId" AND ${notDeleted("e")}
      AND ${sql.raw(actualExpenseSql("e"))} AND e."lineKind"=${sqlEnumConstant(expenseLineKindSchema, expenseLineKindSchema.enum.principal)} AND e.cost>0
    ORDER BY ka.depth,e.date DESC NULLS LAST,e.shortcode LIMIT ${CONTRIBUTOR_LIMIT + 1}`);
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
    .parse(result.rows);
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
  const result = await unwrapDb(db).execute(sql`
    WITH policies AS (
      SELECT p.shortcode,COALESCE(p."displayLabel",p."orderId",p.shortcode) AS name,
        ${purchaseEvidenceFieldResolutionsSql("p")}->'itemizationExpectation' AS resolution
      FROM "FinancialTransaction" t
      JOIN "FinancialTransactionAllocation" a ON a."transactionId"=t.id AND ${notDeleted("a")}
      JOIN "Purchase" p ON p.id=a."purchaseId" AND ${notDeleted("p")}
      WHERE t.shortcode=${shortcode} AND ${notDeleted("t")}
    ) SELECT shortcode,name,resolution,count(*) OVER()::int AS total
    FROM policies ORDER BY shortcode LIMIT ${CONTRIBUTOR_LIMIT + 1}`);
  const rows = z
    .array(
      z.object({
        shortcode: z.string(),
        name: z.string(),
        resolution: fieldResolutionSchema,
        total: z.number(),
      }),
    )
    .parse(result.rows);
  const categoryResult = await unwrapDb(db).execute(sql`
    SELECT c.shortcode,c."itemizationExpectation" AS value,
      ${linkedPurchaseItemizationExpectationSql("t")} AS "linkedValue",
      ${linkedPurchaseItemizationSourceSql("t")} AS "linkedSource"
    FROM "FinancialTransaction" t
    LEFT JOIN "SpendingCategory" c ON c.id=t."spendingCategoryId" AND ${notDeleted("c")}
    WHERE t.shortcode=${shortcode} AND ${notDeleted("t")}`);
  const category = z
    .object({
      shortcode: z.string().nullable(),
      value: itemizationExpectation.nullable(),
      linkedValue: itemizationExpectation.nullable(),
      linkedSource: fieldResolutionSchema.shape.sourceEntity,
    })
    .optional()
    .parse(categoryResult.rows[0]);
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

/** Lazy evidence is loaded on the same snapshot as the authoritative resolution. */
export async function loadFieldResolutionEvidence(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  resolution: FieldResolution | null,
): Promise<{ evidence: Evidence | null; truncated: boolean }> {
  if (entity === "product" && field === "owners")
    return productOwnersEvidence(db, shortcode);
  // A selected-record explanation can run before the ownership snapshot is
  // published. Load its exact current ladder here, never on ordinary list reads.
  const prepared =
    !resolution && entity === "inventory" && field === "ownerLedgerPartyId"
      ? await inventoryOwnershipFieldSteps(db, shortcode, null)
      : undefined;
  resolution ??= prepared?.currentResolution ?? null;
  if (!resolution) return { evidence: null, truncated: false };
  if (entity === "product" && field === "price")
    return productPriceEvidence(db, shortcode, resolution);
  if (entity === "financialTransaction" && field === "itemizationExpectation")
    return transactionPolicyEvidence(db, shortcode, resolution);
  if (
    entity === "expense" &&
    resolution.mode === "allocated" &&
    ["projectId", "trade", "costType", "spendingCategoryId"].includes(field)
  )
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
      where: (table, { and: both, eq: equals, isNull }) =>
        both(equals(table.shortcode, shortcode), isNull(table.deletedAt)),
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
