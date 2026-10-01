import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  fieldExplanationInput,
  fieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import {
  fieldResolutionSchema,
  projectAllocationsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { cookbookShortcode } from "@cubby/schemas/identifiers";
import { imageProvenanceEvidence } from "@cubby/schemas/image-capture-fields";
import { effectiveInventoryOwnership } from "@cubby/schemas/inventory-ownership";
import { spendingCategoryAllocationsSchema } from "@cubby/schemas/spending-classification";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import { fieldExplanationContract } from "~/contracts/field-explanation.contract";
import {
  executeEntityAs,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCookbookSummary } from "~/server/repo/cookbook";
import {
  loadFieldCountEvidence,
  withFieldExplanationSnapshot,
} from "~/server/repo/field-explanation-evidence";
import { loadFieldResolutionEvidence } from "~/server/repo/field-resolution-evidence";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";

const jsonValue = z.json();
const jsonRecord = z.record(z.string(), jsonValue);
const jsonArray = z.array(jsonValue);
const jsonString = z.string();
const kernelEntities = new Set<string>(ENTITY_KERNEL_ENTITIES);
type Json = z.infer<typeof jsonValue>;
type JsonRecord = z.infer<typeof jsonRecord>;
const explanationMetadata = z.object({
  ruleId: z.string(),
  version: z.number().int(),
  description: z.string(),
  readPath: z.string().nullable().optional(),
  resolver: z.enum([
    "field",
    "inventoryOwnership",
    "productValuation",
    "imageRepresentation",
    "imageCapture",
    "productQuantity",
    "recipeTotals",
    "locationValuation",
    "merchantVendorInference",
    "expenseAttribution",
  ]),
  projections: z
    .object({
      list: z.string().optional(),
      detail: z.string().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  sourceDependencies: z
    .array(z.object({ path: z.string(), label: z.string() }))
    .optional(),
  actions: z
    .array(z.enum(["confirmOwner", "inheritOwner", "editSource"]))
    .optional(),
});
type Explanation = z.infer<typeof explanationMetadata>;
type Surface = "list" | "detail" | "summary";

/** Labels the `imageCapture` resolver's source list by `provenanceEvidence.basis`
 * — the precedence `deriveImageCapture` enforces (manual > sighting >
 * import-url > exif > analysis > filename), spelled out for the reader. */
const IMAGE_CAPTURE_BASIS_LABELS = {
  manual: "Manual",
  sighting: "Photo library sightings",
  "import-url": "Import source URL",
  exif: "Embedded EXIF",
  analysis: "Analysis",
  filename: "Filename heuristic",
} as const satisfies Record<
  z.infer<typeof imageProvenanceEvidence>["basis"],
  string
>;

const asJsonRecord = <Projection extends object>(
  value: Projection,
): JsonRecord => jsonRecord.parse(JSON.parse(JSON.stringify(value)));

type ExplanationPathResult = { found: boolean; value: Json };

/** A nullable parent means the projected value is null. An absent key is a
 * declaration/read-projection mismatch and must fail loudly. */
export function readExplanationPath(
  projection: JsonRecord,
  path: string,
): ExplanationPathResult {
  let value: Json = projection;
  for (const segment of path.split(".")) {
    if (value === null) return { found: true, value: null };
    const record = jsonRecord.safeParse(value);
    if (!record.success || !(segment in record.data)) {
      return { found: false, value: null };
    }
    value = record.data[segment]!;
  }
  return { found: true, value };
}

function projectionPath(
  field: { readKey: string | null },
  explanation: Explanation,
  surface: Surface,
): string {
  const declared = explanation.projections?.[surface];
  const path = declared ?? explanation.readPath ?? field.readKey;
  if (!path) {
    throw new Error(
      `Explanation ${explanation.ruleId} has no ${surface} projection`,
    );
  }
  return path;
}

type Source = z.input<typeof fieldExplanationOutput>["sources"][number];

const MAX_EXPLANATION_SOURCES = 50;
const MAX_EVIDENCE_NODES = 500;
const MAX_EVIDENCE_ARRAY_ITEMS = 25;
const MAX_EVIDENCE_OBJECT_FIELDS = 30;
const MAX_EVIDENCE_DEPTH = 8;

const entityReferenceFromValue = (value: Json): Source["entity"] => {
  const stringValue = jsonString.safeParse(value);
  if (stringValue.success) {
    const parsed = parseShortcode(stringValue.data);
    return parsed
      ? { entityKind: parsed.type, entityId: parsed.shortcode }
      : null;
  }
  const record = jsonRecord.safeParse(value);
  if (!record.success) return null;
  const explicit = z
    .object({ entityKind: z.string(), entityId: z.string() })
    .safeParse(record.data);
  if (explicit.success) {
    const parsed = parseShortcode(explicit.data.entityId);
    if (parsed?.type === explicit.data.entityKind)
      return { entityKind: parsed.type, entityId: parsed.shortcode };
  }
  for (const key of [
    "id",
    "productId",
    "recipeId",
    "mealId",
    "purchaseId",
    "expenseId",
    "partyId",
    "ledgerPartyId",
    "transactionId",
    "financialTransactionId",
    "ledgerTransferId",
    "locationId",
    "inventoryId",
    "ingredientId",
    "cookbookId",
    "vendorId",
    "financialAccountId",
    "wishId",
    "plantingId",
    "imageId",
    "projectId",
    "taskId",
    "vendorAccountId",
  ]) {
    const candidate = jsonString.safeParse(record.data[key]);
    if (!candidate.success) continue;
    const parsed = parseShortcode(candidate.data);
    if (parsed) return { entityKind: parsed.type, entityId: parsed.shortcode };
  }
  return null;
};

type BoundedEvidence = { value: Json; truncated: boolean };

function boundEvidenceValue(
  value: Json,
  state: { remaining: number },
  depth = 0,
): BoundedEvidence {
  if (state.remaining <= 0 || depth >= MAX_EVIDENCE_DEPTH)
    return { value: "[evidence truncated]", truncated: true };
  state.remaining -= 1;
  const array = jsonArray.safeParse(value);
  if (array.success) {
    const kept = array.data.slice(0, MAX_EVIDENCE_ARRAY_ITEMS);
    let truncated = kept.length !== array.data.length;
    const bounded: Json[] = [];
    for (const item of kept) {
      const result = boundEvidenceValue(item, state, depth + 1);
      bounded.push(result.value);
      truncated ||= result.truncated;
      if (state.remaining <= 0) {
        truncated ||= bounded.length !== kept.length;
        break;
      }
    }
    return { value: bounded, truncated };
  }
  const record = jsonRecord.safeParse(value);
  if (!record.success) return { value, truncated: false };
  const entries = Object.entries(record.data);
  const kept = entries.slice(0, MAX_EVIDENCE_OBJECT_FIELDS);
  let truncated = kept.length !== entries.length;
  const bounded: Record<string, Json> = {};
  for (const [key, item] of kept) {
    const result = boundEvidenceValue(item, state, depth + 1);
    bounded[key] = result.value;
    truncated ||= result.truncated;
    if (state.remaining <= 0) {
      truncated ||= Object.keys(bounded).length !== kept.length;
      break;
    }
  }
  return { value: bounded, truncated };
}

type BoundedSources = {
  sources: Source[];
  truncated: boolean;
};

export function boundExplanationSources(sources: Source[]): BoundedSources {
  const state = { remaining: MAX_EVIDENCE_NODES };
  const kept = sources.slice(0, MAX_EXPLANATION_SOURCES);
  let truncated = kept.length !== sources.length;
  const bounded = kept.map((source) => {
    const result = boundEvidenceValue(source.value, state);
    truncated ||= result.truncated;
    return { ...source, value: result.value };
  });
  return { sources: bounded, truncated };
}

function dependencySources(
  projection: JsonRecord,
  explanation: Explanation,
): Source[] {
  return (explanation.sourceDependencies ?? []).flatMap((dependency) => {
    const resolved = readExplanationPath(projection, dependency.path);
    if (!resolved.found) {
      throw new Error(
        `Explanation ${explanation.ruleId} source does not expose ${dependency.path}`,
      );
    }
    const source = {
      label: dependency.label,
      entity: entityReferenceFromValue(resolved.value),
      value: resolved.value,
    } satisfies Source;
    if (!Array.isArray(resolved.value)) return [source];
    const linked = resolved.value.flatMap((item, index) => {
      const entity = entityReferenceFromValue(item);
      return entity
        ? [
            {
              label: `${dependency.label} ${index + 1}`,
              entity,
              value: item,
            } satisfies Source,
          ]
        : [];
    });
    return linked.length > 0 ? [source, ...linked] : [source];
  });
}

function explainAllocatedCategorySources(
  projection: JsonRecord,
  explanation: Explanation,
): Source[] | null {
  if (
    explanation.ruleId === "expense.effective-spending-category" &&
    readExplanationPath(projection, "fieldResolutions.spendingCategoryId.mode")
      .value === "allocated"
  ) {
    return spendingCategoryAllocationsSchema
      .parse(projection.spendingCategoryAllocations)
      .map((share): Source => ({
        label: share.spendingCategoryId
          ? "Category share"
          : "Unclassified share",
        entity: share.spendingCategoryId
          ? {
              entityKind: "spendingCategory",
              entityId: share.spendingCategoryId,
            }
          : null,
        value: {
          amount: share.amount,
          basis: share.basis,
          incomplete: share.incomplete,
        },
      }));
  }
  return null;
}

/** Resolver-specific traces only interpret values already present in the same
 * public projection. They never rerun the underlying precedence or totals.
 * `hasResolution` is true when a typed `FieldResolution` was already read for
 * this field — it carries the same source/stored/fallback facts as the
 * declared `sourceDependencies` trio, so that trio is skipped rather than
 * duplicated in the output. */
export function explainProjectionSources(
  projection: JsonRecord,
  explanation: Explanation,
  value: Json,
  hasResolution = false,
): Source[] {
  const categorySources = explainAllocatedCategorySources(
    projection,
    explanation,
  );
  if (categorySources) return categorySources;
  if (
    explanation.ruleId === "expense.effective-project" &&
    readExplanationPath(projection, "fieldResolutions.projectId.mode").value ===
      "allocated"
  ) {
    const allocations = projectAllocationsSchema.parse(
      projection.projectAllocations,
    );
    const purchase = readExplanationPath(projection, "purchaseId").value;
    return [
      {
        label: "Purchase",
        entity: entityReferenceFromValue(purchase),
        value: null,
      },
      ...allocations.map((allocation): Source => {
        const value: JsonRecord = {
          amount: allocation.amount,
          basis:
            allocation.basis === "positive"
              ? "Proportional to positive item amounts across the whole purchase"
              : allocation.basis === "refund"
                ? "Proportional to absolute refund amounts across the whole purchase"
                : "Purchase default; no priced nonzero items",
        };
        if (allocation.incomplete)
          value.priceCoverage = "Incomplete: unpriced items provide no weight";
        return {
          label: allocation.projectId ? "Project share" : "Unassigned share",
          entity: allocation.projectId
            ? { entityKind: "project", entityId: allocation.projectId }
            : null,
          value,
        };
      }),
    ];
  }
  if (explanation.resolver === "expenseAttribution" && Array.isArray(value)) {
    return value.map((attribution) => {
      const parsed = z
        .object({ partyId: z.string().nullable(), weight: z.number() })
        .parse(attribution);
      return {
        label: parsed.partyId
          ? "Attributed ledger party"
          : "Unresolved attribution",
        entity: parsed.partyId
          ? { entityKind: "ledgerParty" as const, entityId: parsed.partyId }
          : null,
        value: { weight: parsed.weight },
      };
    });
  }
  if (!hasResolution) {
    const declared = dependencySources(projection, explanation);
    if (declared.length > 0) return declared;
  }
  switch (explanation.resolver) {
    case "productQuantity":
      return [
        {
          label: "Quantity ledger",
          entity: null,
          value: readExplanationPath(projection, "quantityLedger").value,
        },
        {
          label: "Current inventory entries",
          entity: null,
          value: readExplanationPath(projection, "inventoryEntry").value,
        },
      ];
    case "recipeTotals":
      return [
        {
          label: "Computed recipe totals",
          entity: null,
          value: readExplanationPath(projection, "totals").value,
        },
      ];
    case "locationValuation":
      return [{ label: "Location valuation rollup", entity: null, value }];
    case "merchantVendorInference":
      return [
        {
          label: "Merchant label",
          entity: null,
          value: readExplanationPath(projection, "merchant").value,
        },
        {
          label: "Transaction status",
          entity: null,
          value: readExplanationPath(projection, "status").value,
        },
        {
          label: "Confirmed allocations",
          entity: null,
          value: readExplanationPath(projection, "allocations").value,
        },
        {
          label: "Transfer link",
          entity: null,
          value: readExplanationPath(projection, "ledgerTransferId").value,
        },
        { label: "Matching settled transactions", entity: null, value },
      ];
    case "expenseAttribution":
      return [];
    case "productValuation":
      return [
        {
          label: "Effective product pricing",
          entity: null,
          value: readExplanationPath(projection, "pricing").value,
        },
      ];
    case "imageCapture": {
      const evidence = imageProvenanceEvidence
        .nullable()
        .parse(readExplanationPath(projection, "provenanceEvidence").value);
      const sources: Source[] = [
        {
          label: "Capture attribution",
          entity: null,
          value: readExplanationPath(projection, "captureAttribution").value,
        },
      ];
      if (evidence) {
        sources.push({
          label: IMAGE_CAPTURE_BASIS_LABELS[evidence.basis],
          entity: null,
          value: evidence,
        });
      }
      return sources;
    }
    case "field":
    case "imageRepresentation":
    case "inventoryOwnership":
      return [];
  }
}

async function loadProjection(
  context: Parameters<typeof executeEntityAs>[0],
  entity: Entity,
  entityId: string,
  surface: Surface,
): Promise<JsonRecord> {
  if (entity === "cookbook") {
    const item = await getCookbookSummary(
      context.db,
      cookbookShortcode.parse(entityId),
    );
    if (!item) throw new Error("Entity was not found");
    return asJsonRecord(item);
  }
  if (entity === "usda-food") {
    if (!context.usdaService)
      throw new Error("USDA explanations are unavailable");
    const id = z.coerce.number().int().positive().parse(entityId);
    const item = await context.usdaService.getFoodSummaryByID(id);
    if (!item) throw new Error("Entity was not found");
    return asJsonRecord(item);
  }
  if (!kernelEntities.has(entity))
    throw new Error(`Unsupported explanation entity ${entity}`);
  if (surface !== "detail") {
    const result = await executeEntityAs(context, "list", {
      entity: z.enum(ENTITY_KERNEL_ENTITIES).parse(entity),
      filters: { ids: [entityId] },
      pagination: { pageIndex: 0, pageSize: 1 },
    });
    const item = result.items[0];
    if (!item) throw new Error("Entity was not found");
    return asJsonRecord(item);
  }
  const result = await executeEntityAs(context, "get", {
    entity: z.enum(ENTITY_KERNEL_ENTITIES).parse(entity),
    id: entityId,
    missing: "error",
  });
  if (!result.item) throw new Error("Entity was not found");
  return asJsonRecord(result.item);
}

const actionLabels = {
  confirmOwner: "Confirm owner",
  inheritOwner: "Use inherited owner",
  editSource: "Edit source",
} as const;

type ExplainFieldInput = z.output<typeof fieldExplanationInput>;
type Subject = NonNullable<Source["entity"]>;
type Ownership = z.output<typeof effectiveInventoryOwnership>;
type OwnershipTrace = {
  sources: Source[];
  evidenceFingerprint: string | null;
};

async function loadExplanationSnapshot(
  context: EntityKernelContext,
  input: ExplainFieldInput,
  entity: Entity,
  fieldKey: string,
  needsCountEvidence: boolean,
) {
  if (entity === "usda-food") {
    return {
      projection: await loadProjection(
        context,
        entity,
        input.entityId,
        input.surface,
      ),
      countEvidence: null,
      resolutionEvidence: null,
      resolutionEvidenceTruncated: false,
    };
  }
  return withFieldExplanationSnapshot(context.db, async (snapshotDb) => {
    const snapshotContext: EntityKernelContext = {
      ...context,
      db: snapshotDb,
      services: {
        ...context.services,
        recipeCosting: new RecipeCostingService(snapshotDb, context.usdaClient),
      },
    };
    const projection = await loadProjection(
      snapshotContext,
      entity,
      input.entityId,
      input.surface,
    );
    const resolution = fieldResolutionSchema.safeParse(
      readExplanationPath(projection, `fieldResolutions.${fieldKey}`).value,
    );
    const evidence = await loadFieldResolutionEvidence(
      snapshotDb,
      entity,
      input.entityId,
      fieldKey,
      resolution.success ? resolution.data : null,
    );
    return {
      projection,
      resolutionEvidence: evidence.evidence,
      resolutionEvidenceTruncated: evidence.truncated,
      countEvidence: needsCountEvidence
        ? await loadFieldCountEvidence(
            snapshotDb,
            entity,
            input.entityId,
            fieldKey,
          )
        : null,
    };
  });
}

function ownershipTrace(
  subject: Subject,
  ownership: Ownership,
): OwnershipTrace {
  const sources: Source[] = [
    {
      label: "Stored ownership",
      entity: subject,
      value: { mode: ownership.mode, owner: ownership.explicitOwner },
    },
    {
      label: ownership.basis ?? ownership.source,
      entity: ownership.evidence?.purchaseId
        ? {
            entityKind: "purchase",
            entityId: ownership.evidence.purchaseId,
          }
        : null,
      value: ownership.evidence,
    },
  ];
  for (const id of ownership.evidence?.expenseIds.slice(0, 25) ?? []) {
    sources.push({
      label: "Acquisition expense",
      entity: { entityKind: "expense", entityId: id },
      value: id,
    });
  }
  return { sources, evidenceFingerprint: ownership.evidenceFingerprint };
}

/** `editSource` points at the record that supplies an inherited value; with
 * nothing inherited, the source is the subject itself. */
function explanationActions(
  explanation: Explanation,
  subject: Subject,
  ownership: Ownership | null,
  resolution: FieldResolution | null,
): z.input<typeof fieldExplanationOutput>["actions"] {
  return (explanation.actions ?? []).flatMap((kind) => {
    if (kind === "editSource" && resolution?.sourceEntity)
      return [
        {
          kind,
          label: actionLabels[kind],
          target: {
            entityKind: resolution.sourceEntity.entityKind,
            entityId: resolution.sourceEntity.entityId,
          },
        },
      ];
    if (
      kind === "confirmOwner" &&
      ownership &&
      (ownership.mode !== "inherit" || !ownership.effectiveOwner)
    )
      return [];
    if (kind === "inheritOwner" && ownership?.mode === "inherit") return [];
    return [{ kind, label: actionLabels[kind], target: subject }];
  });
}

export async function explainField(
  context: EntityKernelContext,
  input: ExplainFieldInput,
) {
  const entity = input.entityKind;
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === input.field,
  );
  if (!field?.explanation)
    throw new Error("This field has no declared explanation");
  const explanation = explanationMetadata.parse(field.explanation);
  const snapshot = await loadExplanationSnapshot(
    context,
    input,
    entity,
    field.key,
    (explanation.sourceDependencies?.length ?? 0) === 0,
  );
  const { projection, countEvidence } = snapshot;
  const path = projectionPath(field, explanation, input.surface);
  const resolved = readExplanationPath(projection, path);
  if (!resolved.found)
    throw new Error(`Explanation projection does not expose ${path}`);
  const value = resolved.value;
  const subject = { entityKind: entity, entityId: input.entityId };
  const resolutionPath = readExplanationPath(
    projection,
    `fieldResolutions.${field.key}`,
  );
  const parsedResolution = resolutionPath.found
    ? fieldResolutionSchema.safeParse(resolutionPath.value)
    : null;
  const resolution: FieldResolution | null = parsedResolution?.success
    ? parsedResolution.data
    : null;
  let sources = [
    ...explainProjectionSources(
      projection,
      explanation,
      value,
      resolution !== null,
    ),
    ...(countEvidence?.sources ?? []),
  ];
  const ownership =
    explanation.resolver === "inventoryOwnership"
      ? effectiveInventoryOwnership.parse(value)
      : null;
  const ownershipEvidence = ownership
    ? ownershipTrace(subject, ownership)
    : null;
  if (ownershipEvidence) sources = ownershipEvidence.sources;
  const actions = explanationActions(
    explanation,
    subject,
    ownership,
    resolution,
  );
  const boundedSources = boundExplanationSources(sources);
  return fieldExplanationOutput.parse({
    subject,
    field: field.key,
    label: field.label,
    value,
    evaluatedAt: new Date().toISOString(),
    rule: {
      id: explanation.ruleId,
      revision: explanation.version,
      description: explanation.description,
    },
    sources: boundedSources.sources,
    resolution,
    resolutionEvidence: snapshot.resolutionEvidence,
    truncated:
      boundedSources.truncated ||
      (countEvidence?.truncated ?? false) ||
      snapshot.resolutionEvidenceTruncated,
    evidenceFingerprint: ownershipEvidence?.evidenceFingerprint ?? null,
    actions,
  });
}

export const fieldExplanationHandlers = implementOperationDomain(
  fieldExplanationContract,
  {
    explain: explainField,
  },
);
