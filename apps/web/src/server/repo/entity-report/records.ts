import type { Amount } from "@cubby/schemas/codec";
import type { CollectionActionId } from "@cubby/schemas/entity-definitions/collection-actions";
import {
  labelNutritionSource,
  type ReportBlock,
  type ReportCommand,
  reportSlotActions,
} from "@cubby/schemas/entity-report";
import {
  type ImageId,
  type IngredientId,
  type LedgerPartyId,
  parseEntityId,
  parseShortcodeFor,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import { runPurpose } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import { computeParseDrift, driftAxes } from "~/lib/parse-drift";
import type { Database } from "~/server/db";
import {
  cookbook,
  entityAttachment,
  image,
  ingredient,
  product,
  recipe,
  runTarget,
} from "~/server/db/schema";
import { listRuns, listProductRuns } from "~/server/purchase-import/run-target";
import {
  aiDescriptionItems,
  cookbookItems,
  imageAssociationItems,
  labelImageItems,
  recipeUsageItems,
  runHistoryItems,
  phaseLabel,
  type UsageForItems,
} from "~/server/repo/collection-items";
import { getDb, mapImages, notDeleted } from "~/server/repo/database-helpers";
import { getImageById } from "~/server/repo/image";
import { getImageProcessingReadProjection } from "~/server/repo/image-processing";
import { getRecipeUsagesForIngredient } from "~/server/repo/ingredient/search";
import { readLocationAiDescription } from "~/server/repo/location/ai-description";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

/** Who is asking, for the reads that are scoped to a member's own ledger party. */
export type ReportViewer = () => Promise<{ id: LedgerPartyId } | null>;

/** The `records` block the slots below share. */
const records = (
  rows: Extract<ReportBlock, { kind: "records" }>["rows"],
  empty: string,
  actions: readonly CollectionActionId[] = [],
  thumbnail: Extract<ReportBlock, { kind: "records" }>["thumbnail"] = "small",
): ReportBlock[] => [
  { kind: "records", rows, empty, actions: [...actions], thumbnail },
];

/**
 * Loaded on demand: the WASM formatter (the one web and native share) is only needed once a
 * report has recipe lines to word.
 */
export const amountFormatter = async () => {
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

const liveProductId = (db: Database, code: string) =>
  resolveOrThrow(db, "product", code);

/**
 * A label's detected nutrition is worth reviewing when its preferred analysis read some, and the
 * product has not already saved that very reading (same rule web used to hide its button).
 */
const reviewableLabels = async (
  db: Database,
  labels: readonly { imageId: ImageId; code: string }[],
  saved: { source?: string | null } | null,
) => {
  const reviewable = new Set<string>();
  await Promise.all(
    labels.map(async (label) => {
      const status = await getImageProcessingReadProjection(db, label.imageId);
      const analysis = status.analyses.find((entry) => entry.preferred);
      if (!analysis?.result.nutritionFacts) return;
      if (
        saved?.source !==
        labelNutritionSource(label.code, String(analysis.createdAt))
      )
        reviewable.add(label.code);
    }),
  );
  return reviewable;
};

export const productLabelsReport = async (db: Database, code: string) => {
  const productId = await liveProductId(db, code);
  const [saved] = await getDb(db)
    .select({ labelNutrition: product.labelNutrition })
    .from(product)
    .where(and(eq(product.id, productId), notDeleted(product)));
  const rows = await getDb(db)
    .select({ image })
    .from(entityAttachment)
    .innerJoin(image, eq(entityAttachment.imageId, image.id))
    .where(
      and(
        eq(entityAttachment.entityId, productId),
        notDeleted(entityAttachment),
        eq(entityAttachment.purpose, "label"),
        notDeleted(image),
      ),
    )
    .orderBy(asc(entityAttachment.sortOrder), asc(entityAttachment.createdAt));
  const labels = mapImages(rows.map((entry) => entry.image));
  const reviewable = await reviewableLabels(
    db,
    rows.map((entry, index) => ({
      imageId: parseEntityId("image", entry.image.id),
      code: labels[index]?.id ?? "",
    })),
    saved?.labelNutrition ?? null,
  );
  return records(
    labelImageItems(labels, reviewable),
    "No labels on file.",
    [],
    "large",
  );
};

export const productCookbooksReport = async (db: Database, code: string) => {
  const productId = await liveProductId(db, code);
  const row = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: { id: true },
    with: {
      cookbooks: {
        where: notDeleted(cookbook),
        orderBy: asc(cookbook.name),
        with: {
          recipes: { where: notDeleted(recipe), columns: { deletedAt: true } },
        },
      },
    },
  });
  return records(
    cookbookItems(
      (row?.cookbooks ?? []).map((entry) => ({
        id: parseShortcodeFor("cookbook", entry.shortcode),
        name: entry.name,
        recipeCount: entry.recipes.length,
      })),
    ),
    "Not a cookbook copy.",
  );
};

/**
 * Lines a fresh parse would change, named by axis, with the one command that applies it; parsed
 * once for the whole report. The command carries only the line's ids: the server re-parses and
 * decides what to write (`reparseRecipeLine`), so no client composes a patch.
 */
const driftExtras = async (
  usages: readonly UsageForItems[],
  knownNames: readonly string[],
) => {
  const { wasm } = await import("~/lib/wasm");
  const fresh = wasm.parse_ingredient_lines(
    usages.map((usage) => usage.rawLine ?? ""),
  );
  const byUsage = new Map<UsageForItems, readonly string[]>();
  usages.forEach((usage, index) => {
    const parsed = fresh[index];
    if (!usage.rawLine || !parsed) return;
    const axes = driftAxes(
      computeParseDrift(
        {
          knownNames,
          amounts: usage.amounts,
          modifier: usage.modifier ?? null,
        },
        parsed,
      ),
    );
    if (axes.length > 0) byUsage.set(usage, axes);
  });
  return {
    badgesOf: (usage: UsageForItems) => {
      const axes = byUsage.get(usage);
      return axes ? [`Re-parse changes ${axes.join(", ")}`] : [];
    },
    commandsOf: (usage: UsageForItems): ReportCommand[] =>
      byUsage.has(usage)
        ? [
            {
              id: `reparse:${usage.id}`,
              label: "Re-parse",
              prominent: false,
              confirm: `Re-parse this line in ${usage.recipe.name} with the current parser and apply the result to the recipe?`,
              request: {
                kind: "reparse-line",
                recipeId: recipeShortcode.parse(usage.recipe.id),
                lineId: usage.id,
              },
            },
          ]
        : [],
  };
};

/** Every recipe line an ingredient is used in, each drifted one with its re-parse. */
const recipeUsagesReport = async (
  db: Database,
  ingredient: { id: IngredientId; name: string; aliases: readonly string[] },
) => {
  const usages = (await getRecipeUsagesForIngredient(db, ingredient.id))
    .recipeUsages;
  if (usages.length === 0) return records([], "Not used in any recipes yet.");
  const { badgesOf, commandsOf } = await driftExtras(usages, [
    ingredient.name,
    ...ingredient.aliases,
  ]);
  return records(
    recipeUsageItems(usages, await amountFormatter(), badgesOf, commandsOf),
    "Not used in any recipes yet.",
  );
};

export const productRecipeAppearancesReport = async (
  db: Database,
  code: string,
) => {
  const productId = await liveProductId(db, code);
  const row = await getDb(db).query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: { id: true },
    with: {
      ingredient: {
        columns: { id: true, name: true, aliases: true, deletedAt: true },
      },
    },
  });
  const linked = row?.ingredient?.deletedAt === null ? row.ingredient : null;
  if (!linked) return records([], "Not used in any recipes yet.");
  return recipeUsagesReport(db, linked);
};

export const ingredientRecipeUsagesReport = async (
  db: Database,
  code: string,
) => {
  const id = await resolveOrThrow(db, "ingredient", code);
  const row = await getDb(db).query.ingredient.findFirst({
    where: and(eq(ingredient.id, id), notDeleted(ingredient)),
    columns: { id: true, name: true, aliases: true },
  });
  if (!row) return records([], "Not used in any recipes yet.");
  return recipeUsagesReport(db, row);
};

export const imageAssociationsReport = async (db: Database, code: string) =>
  records(
    imageAssociationItems(
      (await getImageById(db, await resolveOrThrow(db, "image", code)))
        .associations,
    ),
    "This image is not attached to a record.",
    reportSlotActions["image.associations"],
  );

export const locationAiDescriptionReport = async (
  db: Database,
  code: string,
) => {
  const id = await resolveOrThrow(db, "location", code);
  return records(
    aiDescriptionItems(await readLocationAiDescription(db, id)),
    "No photos analyzed yet.",
    reportSlotActions["location.ai-description"],
  );
};

export const recordRunsReport =
  (kind: "product" | "purchase") =>
  async (db: Database, code: string, viewer: ReportViewer) => {
    const party = await viewer();
    if (!party)
      throw new Error("This login is not linked to a member ledger party yet.");
    const entityId = await resolveOrThrow(db, kind, code);
    const runs =
      kind === "product"
        ? await listProductRuns(
            db,
            party.id,
            parseEntityId("product", entityId),
          )
        : await listRuns(db, party.id, parseEntityId("purchase", entityId));
    const targets = runs.length
      ? await getDb(db)
          .select({
            runId: runTarget.runId,
            state: runTarget.state,
            outcome: runTarget.outcome,
            warning: runTarget.warning,
            completedAt: runTarget.completedAt,
          })
          .from(runTarget)
          .where(
            and(
              eq(runTarget.entityId, entityId),
              inArray(
                runTarget.runId,
                runs.map((item) => item.id),
              ),
            ),
          )
      : [];
    return records(
      runHistoryItems(
        runs.map((run) => ({
          ...run,
          purpose: runPurpose.parse(run.purpose),
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
        })),
      ).map((row, index) => {
        const scoped = targets.filter(
          (target) => target.runId === runs[index]?.id,
        );
        const completed = scoped
          .flatMap((target) =>
            target.completedAt ? [target.completedAt.toISOString()] : [],
          )
          .sort()
          .at(-1);
        return {
          ...row,
          title:
            runs[index]?.vendorName ??
            runs[index]?.vendorAccountLabel ??
            (kind === "product" ? "Product enrichment" : row.title),
          subtitle: [
            kind === "product" ? row.subtitle?.split("\n")[0] : row.subtitle,
            ...scoped.flatMap((target) =>
              target.warning ? [target.warning] : [],
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          at: completed ?? row.at,
          trailing: null,
          statuses: [
            { label: phaseLabel(runs[index]!.status) },
            ...Array.from(
              new Set(scoped.map((target) => target.outcome ?? target.state)),
            ).map((outcome) => ({
              label: phaseLabel(outcome),
              tone:
                outcome === "verified"
                  ? ("positive" as const)
                  : [
                        "partially_verified",
                        "ambiguous",
                        "temporarily_blocked",
                        "researched_with_gaps",
                      ].includes(outcome)
                    ? ("warning" as const)
                    : undefined,
            })),
          ],
        };
      }),
      `No research run has been recorded for this ${kind}.`,
    );
  };
