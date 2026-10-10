import {
  classificationReference,
  declaredPoliciesGoverning,
} from "@cubby/schemas/classification-field-policy";
import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import {
  parseEntityId,
  purchaseShortcode,
  spendingCategoryShortcode,
} from "@cubby/schemas/identifiers";
import type { AcceptedResearchFact } from "@cubby/schemas/research";
import type { researchAssessment } from "@cubby/schemas/research-assessment";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { product, purchase } from "~/server/db/schema";
import { classificationRefusesField } from "~/server/repo/classification-field-policy";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";
import { getProductCategoryByShortcode } from "~/server/repo/product-category";
import { updateProduct } from "~/server/repo/product/crud";
import { updatePurchase } from "~/server/repo/purchase";
import {
  lookupEntityReferences,
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-tables";
import { getSpendingCategoryByShortcode } from "~/server/repo/spending-category";

import type { productEnrichmentTarget } from "./product-enrichment-target";

export const acceptedProductField = z.enum(
  entityFieldModels.product.research.fillFields,
);
type ProductField = z.infer<typeof acceptedProductField>;
export const acceptedPurchaseField = z.enum(
  entityFieldModels.purchase.research.fillFields,
);
type PurchaseField = z.infer<typeof acceptedPurchaseField>;
type ProductLive = NonNullable<
  Awaited<ReturnType<typeof productEnrichmentTarget>>
>["live"];
type ProductChanges = Partial<Pick<typeof product.$inferInsert, ProductField>>;
type PurchaseChanges = Partial<
  Pick<typeof purchase.$inferInsert, PurchaseField>
>;
type AcceptedChanges = ProductChanges & PurchaseChanges;
type Contradiction = {
  fieldPath: AcceptedResearchFact["fieldPath"];
  currentValue: AcceptedResearchFact["value"];
  proposedValue: AcceptedResearchFact["value"];
};
type Refusal = z.infer<typeof researchAssessment>["rejected"][number];
type NormalizedFact = {
  fact: AcceptedResearchFact;
  value: string;
  canonical: string;
  write: boolean;
};
type ProductSubject = {
  entityKind: "product";
  entityId: typeof product.$inferSelect.id;
  live: ProductLive;
};
type PurchaseSubject = {
  entityKind: "purchase";
  entityId: typeof purchase.$inferSelect.id;
  live: typeof purchase.$inferSelect;
};
type ResearchSubject = ProductSubject | PurchaseSubject;

type ReferenceIdentity = Pick<
  Awaited<ReturnType<typeof lookupEntityReferences>> extends Map<
    string,
    infer Value
  >
    ? Value
    : never,
  "id" | "name"
>;
type ReferenceContextLoader = (
  db: Database | DrizzleTransaction,
  code: string,
) => Promise<{ path: ReferenceIdentity[] } | null>;

// These catalogs have branch meaning beyond a leaf label. Read their ordinary
// public projections; callers never reconstruct a category from model prose.
const referenceContextLoaders = new Map<
  ShortcodeEntity,
  ReferenceContextLoader
>([
  [
    "productCategory",
    async (db, code) => {
      const category = await getProductCategoryByShortcode(db, code);
      return category ? { path: category.path } : null;
    },
  ],
  [
    "spendingCategory",
    async (db, code) => {
      const path: ReferenceIdentity[] = [];
      const visited = new Set<string>();
      let current: string | null = code;
      while (current && path.length < 100 && !visited.has(current)) {
        visited.add(current);
        const category = await getSpendingCategoryByShortcode(db, current);
        if (!category) return null;
        path.unshift({ id: category.id, name: category.name });
        current = category.parentId;
      }
      // Do not publish a partial branch as authoritative after a cycle or cap.
      return current === null && path.length ? { path } : null;
    },
  ],
]);

/** Live catalog meaning helps assess source support; it is never source evidence. */
export function loadResearchReferenceContext(
  db: Database | DrizzleTransaction,
  input: {
    entityKind: ResearchSubject["entityKind"];
    facts: readonly AcceptedResearchFact[];
  },
) {
  return loadReferenceValues(db, {
    entityKind: input.entityKind,
    facts: input.facts.map((fact, factIndex) => ({ fact, factIndex })),
  });
}

async function loadReferenceValues(
  db: Database | DrizzleTransaction,
  input: {
    entityKind: ResearchSubject["entityKind"];
    facts: readonly { fact: AcceptedResearchFact; factIndex: number }[];
  },
) {
  const fields = entityFieldModels[input.entityKind].fields;
  const allowed =
    input.entityKind === "product"
      ? acceptedProductField
      : acceptedPurchaseField;
  const proposed = input.facts.flatMap(({ fact, factIndex }) => {
    if (!allowed.safeParse(fact.fieldPath).success) return [];
    const declared = fields.find((field) => field.key === fact.fieldPath);
    const value = z.string().safeParse(fact.value);
    if (!declared?.reference || !value.success) return [];
    return [
      {
        factIndex,
        fieldPath: fact.fieldPath,
        orderIndex: fact.orderIndex,
        value: value.data,
        entity: z.enum(shortcodeEntities).parse(declared.reference.entity),
      },
    ];
  });
  const groups = new Map<ShortcodeEntity, typeof proposed>();
  for (const fact of proposed) {
    const group = groups.get(fact.entity) ?? [];
    group.push(fact);
    groups.set(fact.entity, group);
  }
  const result: Array<{
    factIndex: number;
    entityKind: ResearchSubject["entityKind"];
    fieldPath: AcceptedResearchFact["fieldPath"];
    orderIndex?: AcceptedResearchFact["orderIndex"];
    reference: ReferenceIdentity & { path?: ReferenceIdentity[] };
  }> = [];
  for (const [entity, facts] of groups) {
    const resolved = await resolveLiveShortcodes(
      db,
      facts.map((fact) => fact.value),
      entity,
    );
    const references = await lookupEntityReferences(db, entity, [
      ...resolved.values(),
    ]);
    const details = new Map<
      string,
      Awaited<ReturnType<ReferenceContextLoader>>
    >();
    for (const fact of facts) {
      const id = resolved.get(fact.value);
      const reference = id ? references.get(id) : undefined;
      if (!reference) continue;
      const load = referenceContextLoaders.get(entity);
      if (load && !details.has(reference.id))
        details.set(reference.id, await load(db, reference.id));
      const extra = details.get(reference.id);
      if (load && !extra) continue;
      const entry: (typeof result)[number] = {
        factIndex: fact.factIndex,
        entityKind: input.entityKind,
        fieldPath: fact.fieldPath,
        reference: { id: reference.id, name: reference.name, ...extra },
      };
      if (input.entityKind === "purchase" && fact.orderIndex !== undefined)
        entry.orderIndex = fact.orderIndex;
      result.push(entry);
    }
  }
  return result.sort((left, right) => left.factIndex - right.factIndex);
}

type ReferenceAssessment = {
  facts: readonly AcceptedResearchFact[];
  values: Awaited<ReturnType<typeof loadResearchReferenceContext>>;
};

/** Protect the meaning the assessor saw, including absent references becoming live. */
async function refusedReferenceFields(
  tx: DrizzleTransaction,
  input: {
    entityKind: ResearchSubject["entityKind"];
    claims: readonly AcceptedResearchFact[];
    referenceAssessment?: ReferenceAssessment;
  },
) {
  const assessment = input.referenceAssessment;
  if (!assessment) return new Set<string>();
  const indexed = assessment.facts.flatMap((fact, factIndex) =>
    input.claims.some(
      (claim) =>
        claim.fieldPath === fact.fieldPath &&
        claim.orderIndex === fact.orderIndex &&
        claim.evidenceId === fact.evidenceId &&
        claim.value === fact.value,
    )
      ? [{ fact, factIndex }]
      : [],
  );
  const model = entityFieldModels[input.entityKind];
  const codes = new Map<ShortcodeEntity, Set<string>>();
  for (const { fact, factIndex } of indexed) {
    const declared = model.fields.find((field) => field.key === fact.fieldPath);
    const value = z.string().safeParse(fact.value);
    if (!declared?.reference || !value.success) continue;
    const entity = z.enum(shortcodeEntities).parse(declared.reference.entity);
    const wanted = codes.get(entity) ?? new Set<string>();
    wanted.add(value.data);
    const before = assessment.values.find(
      (value) => value.factIndex === factIndex,
    );
    for (const part of before?.reference.path ?? []) wanted.add(part.id);
    codes.set(entity, wanted);
  }
  // A second read alone leaves rename/reparent races after comparison. Hold
  // the referenced rows and the assessed ancestry until writes/proofs commit.
  for (const [entity, wanted] of [...codes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ids = await resolveLiveShortcodes(tx, [...wanted], entity);
    if (!ids.size) continue;
    const table = SHORTCODE_TABLE[entity];
    await tx
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, [...ids.values()]), notDeleted(table)))
      .orderBy(asc(table.id))
      .for("share");
  }
  const current = await loadReferenceValues(tx, {
    entityKind: input.entityKind,
    facts: indexed,
  });
  const changed = new Set<string>();
  for (const { fact, factIndex } of indexed) {
    const before = assessment.values.find(
      (value) => value.factIndex === factIndex,
    );
    const after = current.find((value) => value.factIndex === factIndex);
    const declared = model.fields.find((field) => field.key === fact.fieldPath);
    if (
      declared?.reference &&
      (!before || JSON.stringify(before) !== JSON.stringify(after))
    )
      changed.add(fact.fieldPath);
  }
  return changed;
}

function acceptedFieldFor(subject: ResearchSubject, field: string) {
  return subject.entityKind === "product"
    ? acceptedProductField.parse(field)
    : acceptedPurchaseField.parse(field);
}

async function normalizeFields(
  tx: DrizzleTransaction,
  subject: ResearchSubject,
  claims: readonly AcceptedResearchFact[],
  reviewedCurrentValues?: ReadonlyMap<string, AcceptedResearchFact["value"]>,
  refusedReferences: ReadonlySet<string> = new Set(),
) {
  const model = entityFieldModels[subject.entityKind];
  const normalized: NormalizedFact[] = [];
  const contradictions: Contradiction[] = [];
  const refusals: Refusal[] = [];
  const fields = new Set<string>();
  const live = z.record(z.string(), z.unknown()).parse(subject.live);
  for (const proposed of claims) {
    const fact = {
      ...proposed,
      fieldPath: acceptedFieldFor(subject, proposed.fieldPath),
    };
    if (fields.has(fact.fieldPath))
      throw new Error("A research field has competing accepted values.");
    fields.add(fact.fieldPath);
    if (refusedReferences.has(fact.fieldPath)) {
      refusals.push({
        path: fact.fieldPath,
        reason:
          "The proposed catalog reference lacks an unchanged, complete live mapping from source assessment; reassess its current meaning.",
      });
      continue;
    }
    const value = z.string().trim().min(1).max(300).parse(fact.value);
    const declared = model.fields.find((field) => field.key === fact.fieldPath);
    const canonical = declared?.reference
      ? await resolveLiveShortcode(
          tx,
          value,
          z.enum(shortcodeEntities).parse(declared.reference.entity),
        )
      : value;
    if (canonical === null) {
      refusals.push({
        path: fact.fieldPath,
        reason:
          "The proposed catalog reference is not an existing live record of the declared entity.",
      });
      continue;
    }
    const existing = z.string().nullable().parse(live[fact.fieldPath]);
    const missing =
      subject.entityKind === "product" && fact.fieldPath === "manufacturer"
        ? isUnspecifiedManufacturer(existing)
        : !existing;
    const reviewed = reviewedCurrentValues?.has(fact.fieldPath) === true;
    if (reviewed && reviewedCurrentValues?.get(fact.fieldPath) !== existing)
      throw new Error("Reviewed research field changed before approval.");
    if (!missing && existing !== canonical && !reviewed) {
      contradictions.push({
        fieldPath: fact.fieldPath,
        currentValue: existing,
        proposedValue: value,
      });
      continue;
    }
    normalized.push({ fact, value, canonical, write: missing || reviewed });
  }
  return { normalized, contradictions, refusals };
}

async function stagedClassificationBasis(
  tx: DrizzleTransaction,
  subject: ResearchSubject,
  normalized: readonly NormalizedFact[],
) {
  const references = new Set(
    normalized.flatMap(({ fact }) =>
      declaredPoliciesGoverning(subject.entityKind, fact.fieldPath)
        .map(classificationReference)
        .filter((reference): reference is string => reference !== null),
    ),
  );
  const basis: Record<string, string | null> = {};
  const current = z.record(z.string(), z.unknown()).parse(subject.live);
  const model = entityFieldModels[subject.entityKind];
  for (const reference of references) {
    const accepted = normalized.find(
      ({ fact }) => fact.fieldPath === reference,
    );
    if (accepted) {
      basis[reference] = accepted.value;
      continue;
    }
    const declared = model.fields.find((field) => field.key === reference);
    const id = z.string().nullable().parse(current[reference]);
    if (!id || !declared?.reference) {
      basis[reference] = null;
      continue;
    }
    const table =
      SHORTCODE_TABLE[
        z.enum(shortcodeEntities).parse(declared.reference.entity)
      ];
    const [row] = await tx
      .select({ shortcode: table.shortcode })
      .from(table)
      .where(and(eq(table.id, id), notDeleted(table)));
    basis[reference] = row?.shortcode ?? null;
  }
  return basis;
}

function productChange(changes: ProductChanges, field: NormalizedFact) {
  const fieldPath = acceptedProductField.parse(field.fact.fieldPath);
  switch (fieldPath) {
    case "categoryId":
      changes.categoryId = parseEntityId("productCategory", field.canonical);
      break;
    case "ingredientId":
      changes.ingredientId = parseEntityId("ingredient", field.canonical);
      break;
    case "growsPlantId":
      changes.growsPlantId = parseEntityId("plant", field.canonical);
      break;
    default:
      changes[fieldPath] = field.value;
  }
}

function acceptedChange(
  subject: ResearchSubject,
  changes: AcceptedChanges,
  field: NormalizedFact,
) {
  if (subject.entityKind === "product") {
    productChange(changes, field);
    return;
  }
  const fieldPath = acceptedPurchaseField.parse(field.fact.fieldPath);
  changes[fieldPath] = parseEntityId("spendingCategory", field.canonical);
}

/** Callers own semantic acceptance, current-task locking and operation replay. */
export async function commitAcceptedResearchFields(
  tx: DrizzleTransaction,
  input: ResearchSubject & {
    claims: readonly AcceptedResearchFact[];
    actor: ActorContext;
    referenceAssessment?: ReferenceAssessment;
    /** Supplied only after an explicit, current generic finding approval. */
    reviewedCurrentValues?: ReadonlyMap<string, AcceptedResearchFact["value"]>;
  },
) {
  const { normalized, contradictions, refusals } = await normalizeFields(
    tx,
    input,
    input.claims,
    input.reviewedCurrentValues,
    await refusedReferenceFields(tx, input),
  );
  // An accepted classifier governs dependent links in either proposal order.
  const basis = await stagedClassificationBasis(tx, input, normalized);
  const changes: AcceptedChanges = {};
  const admitted: NormalizedFact[] = [];
  for (const field of normalized) {
    if (
      field.write &&
      (await classificationRefusesField(
        tx,
        input.entityKind,
        field.fact.fieldPath,
        basis,
      ))
    ) {
      refusals.push({
        path: field.fact.fieldPath,
        reason: "The accepted entity classification refuses this field.",
      });
      continue;
    }
    if (field.write) acceptedChange(input, changes, field);
    admitted.push(field);
  }
  if (Object.keys(changes).length) {
    if (input.entityKind === "product")
      await updateProduct(
        databaseForTransaction(tx),
        input.entityId,
        changes,
        input.actor,
      );
    else
      await updatePurchase(
        databaseForTransaction(tx),
        purchaseShortcode.parse(input.live.shortcode),
        {
          spendingCategoryId: spendingCategoryShortcode.parse(
            admitted.find(
              (field) => field.fact.fieldPath === "spendingCategoryId",
            )?.value,
          ),
        },
        input.actor,
        { spendingCategoryOrigin: "source" },
      );
  }
  const table = input.entityKind === "product" ? product : purchase;
  const [saved] = await tx
    .select()
    .from(table)
    .where(and(eq(table.id, input.entityId), notDeleted(table)));
  if (!saved) throw new Error("Research entity disappeared during commit.");
  const current = z.record(z.string(), z.unknown()).parse(input.live);
  const canonical = z.record(z.string(), z.unknown()).parse(saved);
  const permittedFields =
    input.entityKind === "product"
      ? acceptedProductField
      : acceptedPurchaseField;
  const changedFields = new Set<string>(
    permittedFields.options.filter(
      (field) => canonical[field] !== current[field],
    ),
  );
  const claims: AcceptedResearchFact[] = [];
  for (const field of admitted) {
    if (canonical[field.fact.fieldPath] !== field.canonical) {
      refusals.push({
        path: field.fact.fieldPath,
        reason: "The domain update did not retain the accepted field value.",
      });
      continue;
    }
    claims.push({ ...field.fact, value: field.canonical });
  }
  return { changes, changedFields, claims, contradictions, refusals };
}
