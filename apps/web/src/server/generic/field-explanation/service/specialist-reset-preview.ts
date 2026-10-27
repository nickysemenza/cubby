import type { Entity } from "@cubby/schemas/entity";
import { fieldResult, fieldSource } from "@cubby/schemas/field-envelope";
import {
  fieldResolutionSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { expenseId, projectShortcode } from "@cubby/schemas/identifiers";
import { resolveRecipeServingValue } from "@cubby/schemas/recipe-shared";
import { rawExpenseOut } from "@cubby/schemas/work-raw-read";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { getExpenseByID } from "~/server/domains/expense/repo/crud";
import {
  resolveDraftExpenseFields,
  type ExpenseFieldDraft,
} from "~/server/domains/expense/repo/expense-inheritance";
import { loadInventoryOwnershipTraces } from "~/server/domains/inventory/repo/ownership";
import {
  loadProductPricing,
  resolveProductPriceField,
} from "~/server/domains/product/repo/pricing";
import { resolveDraftEvidenceFields } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { identityShortcodes } from "~/server/entity-kernel/repo/entity-identity";
import { explanationReferenceValues } from "~/server/generic/field-explanation/repo/explanation-reference-values";
import {
  readVendorResetResolution,
  readInventoryResetEntry,
  readExpenseCategoryResetResolution,
  readRecipeResetState,
  readProductResetState,
  readProjectTradeResetFact,
} from "~/server/generic/field-explanation/repo/specialist-reset-queries";
import { shortcodeLabels } from "~/server/generic/shortcode/repo/shortcode-labels";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const resultSchema = fieldResult(z.json());

async function resolutionPreview(
  db: Database,
  resolution: FieldResolution,
  mechanism: "computed" | "default" = "default",
): Promise<z.output<typeof resultSchema>> {
  const [source] = resolution.sourceEntity
    ? await explanationReferenceValues(db, [resolution.sourceEntity])
    : [];
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome:
        resolution.value === null
          ? { kind: "empty", reason: resolution.emptyReason ?? "unset" }
          : { kind: "value", value: resolution.value },
      provenance: source
        ? { kind: "inherited", source: fieldSource.parse(source) }
        : resolution.value === null
          ? null
          : mechanism === "computed"
            ? { kind: "computed" }
            : { kind: "default", source: null },
    },
  });
}

/** Selected-record explanation work only; this never reads a published fallback. */
export async function specialistResetPreview(
  db: Database,
  entity: Entity,
  field: string,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  if (field === "itemizationExpectation") {
    return evidenceResetPreview(db, entity, field, internalId);
  }
  if (entity === "inventory" && field === "ownerLedgerPartyId") {
    return inventoryOwnershipResetPreview(db, internalId);
  }
  if (entity === "expense" && field === "spendingCategoryId") {
    return expenseCategoryResetPreview(db, internalId);
  }
  if (entity === "recipe" && field === "servings") {
    return recipeServingsResetPreview(db, internalId);
  }
  if (entity === "product" && field === "price") {
    return productPriceResetPreview(db, internalId);
  }
  if (entity === "expense" && (field === "trade" || field === "projectId")) {
    return expenseInheritanceResetPreview(db, field, internalId);
  }
  return null;
}

async function evidenceResetPreview(
  db: Database,
  entity: Entity,
  field: string,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  if (entity === "purchase" || entity === "financialTransaction") {
    const identity = (await identityShortcodes(db, [internalId])).get(
      internalId,
    );
    if (!identity?.shortcode)
      throw new Error("Reset preview requires a live entity identity");
    const resolutions = await resolveDraftEvidenceFields(db, {
      entity,
      entityId: identity.shortcode,
      basis: { itemizationExpectation: null },
    });
    return resolutionPreview(
      db,
      fieldResolutionSchema.parse(resolutions[field]),
    );
  }
  if (entity === "vendor") {
    const resolution = await readVendorResetResolution(db, internalId, field);
    return resolution ? resolutionPreview(db, resolution, "computed") : null;
  }

  return null;
}

async function inventoryOwnershipResetPreview(
  db: Database,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  const entry = await readInventoryResetEntry(db, internalId);
  if (entry.ownershipMode === "inherit") return null;
  const trace = (
    await loadInventoryOwnershipTraces(db, [
      { ...entry, ownershipMode: "inherit", ownerLedgerPartyId: null },
    ])
  ).get(entry.id);
  if (!trace)
    throw new Error("Inventory reset computation produced no ownership trace");
  const owner = trace.ownership.effectiveOwner;
  const decider = trace.steps.find((step) => step.decides);
  const [source] = trace.fallbackSource
    ? await explanationReferenceValues(db, [trace.fallbackSource])
    : [];
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome: owner
        ? { kind: "value", value: owner.id }
        : {
            kind: "empty",
            reason: decider?.effect === "blocked" ? "blocked" : "unset",
          },
      provenance: source
        ? { kind: "inherited", source: fieldSource.parse(source) }
        : null,
    },
  });
}

async function expenseCategoryResetPreview(
  db: Database,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  const resolution = await readExpenseCategoryResetResolution(db, internalId);
  return resolution ? resolutionPreview(db, resolution) : null;
}

async function recipeServingsResetPreview(
  db: Database,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  const current = await readRecipeResetState(db, internalId);
  if (current.servings === null) return null;
  const value = resolveRecipeServingValue({ ...current, servings: null });
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome:
        value === null
          ? { kind: "empty", reason: "unset" }
          : { kind: "value", value },
      provenance: value === null ? null : { kind: "computed" },
    },
  });
}

async function productPriceResetPreview(
  db: Database,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  const product = await readProductResetState(db, internalId);
  if (product.service || product.price === null) return null;
  const pricing = (
    await loadProductPricing(db, [{ id: product.id, price: null }])
  ).get(product.id);
  if (!pricing)
    throw new Error("Product reset computation produced no pricing result");
  const current = resolveProductPriceField(
    product.price,
    pricing,
    product.service,
  );
  if (!current.canReset || current.assignmentAllowed === false) return null;
  const reset = resolveProductPriceField(null, pricing, product.service);
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome:
        reset.value === null
          ? { kind: "empty", reason: reset.emptyReason ?? "unset" }
          : { kind: "value", value: reset.value },
      // The kit/Expense aggregate has no single deciding source record.
      provenance: { kind: "computed" },
    },
  });
}

async function expenseInheritanceResetPreview(
  db: Database,
  field: "trade" | "projectId",
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  const row = await getExpenseByID(db, expenseId.parse(internalId));
  if (row.lineKind !== "principal") return null;
  const storedTrade = fieldResolutionSchema.parse(row.fieldResolutions?.trade);
  const storedProject = fieldResolutionSchema.parse(
    row.fieldResolutions?.projectId,
  );
  const draft = {
    name: row.name,
    lineKind: row.lineKind,
    // Preserve local project intent: the effective Project is not an assignment.
    projectId: z.string().nullable().parse(storedProject.storedValue),
    productId: row.productId,
    purchaseId: row.purchaseId,
    trade: rawExpenseOut.shape.trade.parse(storedTrade.storedValue),
    costType: row.costType,
  } satisfies ExpenseFieldDraft;
  const current = (await resolveDraftExpenseFields(db, draft))[field];
  if (!current?.canReset || current.assignmentAllowed === false) return null;
  const reset = (
    await resolveDraftExpenseFields(db, { ...draft, [field]: null })
  )[field];
  if (!reset)
    throw new Error("Expense reset computation produced no trade result");
  let source = reset.sourceEntity;
  if (field === "trade" && source?.entityKind === "project") {
    const id = await resolveOrThrow(db, "project", source.entityId);
    const fact = await readProjectTradeResetFact(db, id);
    // The value and deciding ancestor must describe the same live counterfactual.
    if (fact.value !== reset.value)
      throw new Error(
        "Expense trade reset source no longer matches its live value",
      );
    const [hydrated] = await explanationReferenceValues(db, [
      {
        entityKind: "project",
        entityId: fact.source.id,
        name: null,
      },
    ]);
    const publicSource = fieldSource.parse(hydrated);
    const code = projectShortcode.parse(publicSource.entityId);
    const labels = await shortcodeLabels(db, [code]);
    source = {
      entityKind: "project",
      entityId: code,
      name: labels.get(code) ?? null,
    };
  }
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome:
        reset.value === null
          ? { kind: "empty", reason: reset.emptyReason ?? "unset" }
          : { kind: "value", value: reset.value },
      provenance: source
        ? { kind: "inherited", source }
        : reset.value === null
          ? null
          : { kind: "default", source: null },
    },
  });
}
