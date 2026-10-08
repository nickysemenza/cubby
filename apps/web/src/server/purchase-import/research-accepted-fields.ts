import {
  classificationReference,
  declaredPoliciesGoverning,
} from "@cubby/schemas/classification-field-policy";
import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import {
  parseEntityId,
  purchaseShortcode,
  spendingCategoryShortcode,
} from "@cubby/schemas/identifiers";
import type { AcceptedResearchFact } from "@cubby/schemas/research";
import type { researchAssessment } from "@cubby/schemas/research-assessment";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { DrizzleTransaction } from "~/server/db";
import { product, purchase } from "~/server/db/schema";
import { classificationRefusesField } from "~/server/repo/classification-field-policy";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";
import { updateProduct } from "~/server/repo/product/crud";
import { updatePurchase } from "~/server/repo/purchase";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-tables";

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
      declaredPoliciesGoverning(subject.entityKind, fact.fieldPath).map(
        classificationReference,
      ),
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
    /** Supplied only after an explicit, current generic finding approval. */
    reviewedCurrentValues?: ReadonlyMap<string, AcceptedResearchFact["value"]>;
  },
) {
  const { normalized, contradictions, refusals } = await normalizeFields(
    tx,
    input,
    input.claims,
    input.reviewedCurrentValues,
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
