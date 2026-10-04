import type { Amount } from "@cubby/schemas/codec";
import type { ReportBlock } from "@cubby/schemas/entity-report";
import { type LedgerPartyId, parseEntityId } from "@cubby/schemas/identifiers";
import { runPurpose } from "@cubby/schemas/run-fields";

import type { Database } from "~/server/db";
import { listRuns } from "~/server/purchase-import/run-target";
import {
  aiDescriptionItems,
  cookbookItems,
  imageAssociationItems,
  labelImageItems,
  recipeUsageItems,
  runHistoryItems,
} from "~/server/repo/collection-items";
import { getImageById } from "~/server/repo/image";
import { getRecipeUsagesForIngredient } from "~/server/repo/ingredient/search";
import { getLocationById } from "~/server/repo/location/crud";
import { getProductByID } from "~/server/repo/product/crud";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

/** Who is asking, for the reads that are scoped to a member's own ledger party. */
export type ReportViewer = () => Promise<{ id: LedgerPartyId } | null>;

/** The `records` block the slots below share. */
const records = (
  rows: Extract<ReportBlock, { kind: "records" }>["rows"],
  empty: string,
  actions: Extract<ReportBlock, { kind: "records" }>["actions"] = [],
): ReportBlock[] => [{ kind: "records", rows, empty, actions }];

/**
 * Loaded on demand: the WASM formatter (the one web and native share) is only needed once a
 * report has recipe lines to word.
 */
const amountFormatter = async () => {
  const { wasm } = await import("~/lib/wasm");
  return (amount: Amount) => {
    const request: Parameters<typeof wasm.format_amount_labeled>[0] = {
      value: amount.value,
      unit: amount.unit,
    };
    if (amount.upperValue != null) request.upper_value = amount.upperValue;
    return wasm.format_amount_labeled(request);
  };
};

const productOf = async (db: Database, code: string) =>
  getProductByID(db, await resolveOrThrow(db, "product", code));

export const productLabelsReport = async (db: Database, code: string) =>
  records(
    labelImageItems((await productOf(db, code)).labelImages),
    "No labels on file.",
    ["reviewLabelNutrition"],
  );

export const productCookbooksReport = async (db: Database, code: string) =>
  records(
    cookbookItems((await productOf(db, code)).cookbooks),
    "Not a cookbook copy.",
  );

export const productRecipeAppearancesReport = async (
  db: Database,
  code: string,
) => {
  const product = await productOf(db, code);
  const ingredientId = product.ingredient
    ? await resolveLiveShortcode(db, product.ingredient.id, "ingredient")
    : null;
  const usages = ingredientId
    ? (
        await getRecipeUsagesForIngredient(
          db,
          parseEntityId("ingredient", ingredientId),
        )
      ).recipeUsages
    : [];
  return records(
    usages.length === 0
      ? []
      : recipeUsageItems(usages, await amountFormatter()),
    "Not used in any recipes yet.",
  );
};

export const imageAssociationsReport = async (db: Database, code: string) =>
  records(
    imageAssociationItems(
      (await getImageById(db, await resolveOrThrow(db, "image", code)))
        .associations,
    ),
    "This image is not attached to a record.",
    ["attachImage"],
  );

export const locationAiDescriptionReport = async (db: Database, code: string) =>
  records(
    aiDescriptionItems(
      (await getLocationById(db, await resolveOrThrow(db, "location", code)))
        .aiDescription,
    ),
    "No photos analyzed yet.",
    ["analyzeLocation"],
  );

export const purchaseRunsReport = async (
  db: Database,
  code: string,
  viewer: ReportViewer,
) => {
  const party = await viewer();
  if (!party)
    throw new Error("This login is not linked to a member ledger party yet.");
  const purchaseId = await resolveLiveShortcode(db, code, "purchase");
  if (purchaseId === null) throw new Error("Purchase was not found");
  const runs = await listRuns(db, party.id, purchaseId);
  return records(
    runHistoryItems(
      runs.map((run) => ({
        ...run,
        purpose: runPurpose.parse(run.purpose),
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
      })),
    ),
    "No import run has been recorded for this purchase.",
    ["validatePurchase"],
  );
};
