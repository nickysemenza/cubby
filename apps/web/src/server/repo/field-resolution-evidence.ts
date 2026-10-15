import { type Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type {
  FieldDecisionStep,
  FieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import {
  fieldResolutionSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { humanize, parseShortcode } from "@cubby/shared";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";

import { getDb, notDeleted, unwrapDb } from "./database-helpers";
import { expenseSpendingCategoryResolutionSql } from "./expense-category-resolution";
import { effectiveExpenseProjectSql } from "./expense-inheritance";
import {
  type InventoryOwnershipStep,
  loadInheritedProductSteps,
  loadInventoryOwnershipTraces,
  inventoryOwnerResolution,
} from "./inventory/ownership";
import { shortcodeLabels } from "./shortcode-labels";
import {
  effectiveTaskProjectSql,
  eligibleParentTaskTradeSql,
} from "./task-project-inheritance";

type Evidence = NonNullable<FieldExplanationOutput["resolutionEvidence"]>;
type Json = z.infer<ReturnType<typeof z.json>>;
type Ref = { entityKind: Entity; entityId: string };

const nodeSchema = z.object({
  shortcode: z.string(),
  name: z.string(),
  depth: z.number(),
  value: z.json(),
  assigned: z.boolean(),
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
  decision?: Pick<
    FieldDecisionStep,
    "source" | "reason" | "effect" | "observed"
  >;
  branch?: FieldDecisionStep["branch"];
  lines?: ReportRecordRow["lines"];
};

const source = (kind: AncestryKind, node: Node | undefined) =>
  node ? { entityKind: kind, entityId: node.shortcode, name: node.name } : null;

/** Match canonical inheritance's bounded traversal; expose only public identities. */
async function ancestors(
  db: Database,
  kind: AncestryKind,
  start: SQL,
  field: string,
): Promise<Node[]> {
  const config =
    kind === "project"
      ? { table: "Project", parent: "parentProjectId" }
      : kind === "task"
        ? { table: "Task", parent: "parentTaskId" }
        : { table: "ProductCategory", parent: "parentId" };
  const table = sql.identifier(config.table);
  const parent = sql.identifier(config.parent);
  let value: SQL;
  let assigned: SQL;
  if (kind === "productCategory" && field === "feature") {
    value = sql`to_jsonb(p.feature)`;
    assigned = sql`p.feature IS NOT NULL`;
  } else if (kind === "productCategory") {
    value = sql`jsonb_build_object('mode',p."spendingCategoryMode",'category',(SELECT c.shortcode FROM "SpendingCategory" c WHERE c.id=p."spendingCategoryId" AND c."deletedAt" IS NULL))`;
    assigned = sql`p."spendingCategoryMode" <> 'inherit'`;
  } else if (kind === "project" && field === "locations") {
    value = sql`to_jsonb(p.locations)`;
    assigned = sql`p."locationsMode" = 'explicit'`;
  } else if (kind === "project" && field === "assigneeId") {
    value = sql`to_jsonb((SELECT l.shortcode FROM "LedgerParty" l WHERE l.id=p."assigneeId" AND l."deletedAt" IS NULL))`;
    assigned = sql`p."assigneeMode" = 'explicit'`;
  } else if (
    kind === "task" &&
    (field === "projectId" || field === "subjectProductId")
  ) {
    const target = field === "projectId" ? sql`"Project"` : sql`"Product"`;
    const column = sql.identifier(field);
    const mode = sql.identifier(
      field === "projectId" ? "projectMode" : "subjectProductMode",
    );
    value = sql`to_jsonb((SELECT c.shortcode FROM ${target} c WHERE c.id=p.${column} AND c."deletedAt" IS NULL))`;
    assigned = sql`p.${mode} = 'explicit' OR p.${column} IS NOT NULL`;
  } else {
    const trade = sql.identifier(kind === "project" ? "defaultTrade" : "trade");
    value = sql`to_jsonb(p.${trade})`;
    assigned = sql`p.${trade} IS NOT NULL`;
  }
  const maxDepth = kind === "productCategory" ? 3 : 100;
  const rows = await unwrapDb(db).execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT p.id,p.${parent} AS parent,p.shortcode,p.name,${value} AS value,${assigned} AS assigned,0 AS depth,ARRAY[p.id] AS visited
      FROM ${table} p WHERE p.id=${start} AND p."deletedAt" IS NULL
      UNION ALL
      SELECT p.id,p.${parent},p.shortcode,p.name,${value},${assigned},a.depth+1,a.visited||p.id
      FROM ancestry a JOIN ${table} p ON p.id=a.parent
      WHERE p."deletedAt" IS NULL AND a.depth<${maxDepth} AND NOT p.id=ANY(a.visited)
    ) SELECT shortcode,name,value,assigned,depth FROM ancestry ORDER BY depth`);
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
  assigned: resolution.mode === "explicit" || resolution.mode === "none",
  self: true,
});

async function eligibleTaskTradeSource(
  db: Database,
  shortcode: string,
  nodes: Node[],
) {
  const eligible = await unwrapDb(db).execute(sql`
    SELECT ${eligibleParentTaskTradeSql("t")} AS trade
    FROM "Task" t WHERE t.shortcode=${shortcode} AND t."deletedAt" IS NULL`);
  const parentEligible = z
    .array(z.object({ trade: z.string().nullable() }))
    .parse(eligible.rows)[0]?.trade;
  return parentEligible
    ? source(
        "task",
        nodes.find((node) => node.depth === 1),
      )
    : null;
}

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

/** Per-field ladders; every other resolved field gets the generic two-step chain. */
async function fieldSteps(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  resolution: FieldResolution,
): Promise<{ steps: Step[]; fallbackSource: Evidence["fallbackSource"] }> {
  const subject = { entity, id: shortcode };
  if (resolution.evaluation)
    return {
      steps: [
        selfStep(entity, resolution),
        ...resolution.evaluation.map((step) => ({
          title: step.name ?? "Category decision",
          ref: { entityKind: step.entityKind, entityId: step.entityId },
          value: step.value,
          assigned: step.assigned,
        })),
      ],
      fallbackSource: resolution.fallbackSource ?? null,
    };
  if (entity === "expense" && field === "spendingCategoryId") {
    const nodes = await ancestors(
      db,
      "productCategory",
      sql`(SELECT g."categoryId" FROM "Expense" e JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL)`,
      field,
    );
    const fallback = await unwrapDb(db).execute(
      sql`SELECT ${expenseSpendingCategoryResolutionSql("e", undefined, true)} AS resolution FROM "Expense" e WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL`,
    );
    return {
      steps: [
        selfStep(entity, resolution),
        ...nodeSteps("productCategory", nodes, subject),
      ],
      fallbackSource: fallback.rows[0]
        ? fieldResolutionSchema.parse(fallback.rows[0].resolution).sourceEntity
        : null,
    };
  }
  if (entity === "expense" && field === "trade") {
    const nodes = await ancestors(
      db,
      "project",
      sql`(SELECT ${effectiveExpenseProjectSql("e")} FROM "Expense" e WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL)`,
      field,
    );
    const row = (
      await unwrapDb(db).execute(
        sql`SELECT p.shortcode,p."defaultTrade" AS trade FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL AND e."lineKind"=${"principal"}`,
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
      sql`(SELECT id FROM "Project" WHERE shortcode=${shortcode} AND "deletedAt" IS NULL)`,
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
      sql`(SELECT id FROM "Task" WHERE shortcode=${shortcode} AND "deletedAt" IS NULL)`,
      field,
    );
    let fallbackSource =
      field === "trade"
        ? await eligibleTaskTradeSource(db, shortcode, nodes)
        : source(
            "task",
            nodes.find((node) => node.depth === 1 && node.assigned),
          );
    const steps = nodeSteps("task", nodes, subject);
    if (field === "trade") {
      const projects = await ancestors(
        db,
        "project",
        sql`(SELECT ${effectiveTaskProjectSql("t")} FROM "Task" t WHERE t.shortcode=${shortcode} AND t."deletedAt" IS NULL)`,
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
      sql`(SELECT id FROM "ProductCategory" WHERE shortcode=${shortcode} AND "deletedAt" IS NULL)`,
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
  if (entity === "inventory" && field === "ownerLedgerPartyId") {
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
    return {
      steps: [
        ownershipSelfStep(resolution, trace?.intent),
        ...ownershipSteps(trace?.steps ?? []),
      ],
      fallbackSource: trace?.fallbackSource ?? null,
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
function winnerIndex(steps: Step[], resolution: FieldResolution): number {
  if (resolution.mode === "explicit" || resolution.mode === "none")
    return steps.findIndex((step) => step.self);
  const id = resolution.sourceEntity?.entityId;
  const byRef = id ? steps.findIndex((step) => step.ref?.entityId === id) : -1;
  if (byRef >= 0) return byRef;
  if (resolution.value === null) return -1;
  return steps.findIndex((step) => !step.self && step.assigned);
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
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
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

async function chainBlock(
  db: Database,
  entity: Entity,
  field: string,
  steps: Step[],
  winner: number,
): Promise<Evidence["chain"]> {
  const codes = new Set<string>();
  for (const step of steps) {
    collectCodes(step.value, codes);
    for (const observation of step.decision?.observed ?? []) {
      if (observation.entity) codes.add(observation.entity.entityId);
      collectCodes(observation.value, codes);
    }
  }
  const labels = await shortcodeLabels(db, [...codes]);
  const model = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  );
  const noneLabel = model?.resolution?.labels?.none;
  const rows: ReportRecordRow[] = steps.map((step, index) => {
    const effect = step.decision?.effect;
    const state: NonNullable<ReportRecordRow["state"]> =
      effect === "used"
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
const MAX_CHAIN_ROWS = 250;
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
  const chain = await chainBlock(db, entity, field, steps, winner);
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

/** Lazy evidence is loaded on the same snapshot as the authoritative resolution. */
export async function loadFieldResolutionEvidence(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  resolution: FieldResolution | null,
): Promise<{ evidence: Evidence | null; truncated: boolean }> {
  if (entity === "product" && field === "owners") {
    const evidence = await productOwnersEvidence(db, shortcode);
    return { evidence, truncated: isTruncated(evidence) };
  }
  if (!resolution) return { evidence: null, truncated: false };
  const { steps, fallbackSource } = await fieldSteps(
    db,
    entity,
    shortcode,
    field,
    resolution,
  );
  const evidence = await evidenceBlock(
    db,
    entity,
    field,
    steps,
    winnerIndex(steps, resolution),
    fallbackSource,
  );
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
): Promise<Evidence> {
  const productId = (
    await getDb(db).query.product.findFirst({
      where: (table, { and: both, eq: equals, isNull }) =>
        both(equals(table.shortcode, shortcode), isNull(table.deletedAt)),
      columns: { id: true },
    })
  )?.id;
  if (!productId)
    return {
      chain: {
        kind: "records",
        presentation: "timeline",
        rows: [],
        empty: "No owner",
      },
      fallbackSource: null,
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
    .orderBy(location.name);
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
      -1,
      null,
    );
    evidence.chain.title = "Acquisition owner context";
    evidence.chain.footer =
      "No live inventory entries. This is the owner context a new inheriting entry would use.";
    evidence.branches = coverage(0, 0);
    return evidence;
  }
  const included = entries.slice(0, 50);
  const traces = await loadInventoryOwnershipTraces(db, included);
  const steps: Step[] = included.flatMap((entry) => {
    const trace = traces.get(entry.id);
    if (!trace) return [];
    const ownership = trace.ownership;
    const inherited = ownership.mode === "inherit";
    const resolution = inventoryOwnerResolution(ownership, trace.steps);
    const self = ownershipSelfStep(resolution, trace.intent);
    const branch = {
      entityKind: "inventory" as const,
      entityId: entry.shortcode,
    };
    return [
      {
        ...self,
        title: entry.locationName,
        ref: { entityKind: "inventory" as const, entityId: entry.shortcode },
        value: ownership.effectiveOwner?.id ?? null,
        assigned: true,
        nullLabel: inherited ? "Unknown" : "Household",
        branch,
      },
      ...ownershipSteps(trace.steps).map((step) => ({
        ...step,
        branch,
      })),
    ];
  });
  const evidence = await evidenceBlock(
    db,
    "inventory",
    "ownerLedgerPartyId",
    steps,
    -1,
    null,
  );
  evidence.branches = coverage(entries.length, included.length);
  if (evidence.branches.omitted > 0)
    evidence.chain.footer = `${included.length} of ${entries.length} inventory entries shown; ${evidence.branches.omitted} omitted.`;
  return evidence;
}
