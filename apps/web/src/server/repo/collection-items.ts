import type { Amount } from "@cubby/schemas/codec";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import type { ImageAssociation } from "@cubby/schemas/image";
import type { ProductCookbookRefOut } from "@cubby/schemas/product";
import { compareRecipeUsages } from "@cubby/schemas/recipe-usage-order";
import type { RunSummary } from "@cubby/schemas/run";

/**
 * Rows for `collection` detail sections (`presentation.detail.sections`, kind `collection`).
 * Each backs one section: web and native list exactly these rows, so a count, a role or a line
 * of text is worded once, here. Kept free of the formatting/WASM modules so the repositories that
 * attach the rows to a record stay light on the request path.
 */

const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

/** The cookbooks whose physical copies this product is, one row each opening the cookbook. */
export const cookbookItems = (
  cookbooks: readonly Pick<
    ProductCookbookRefOut,
    "id" | "name" | "recipeCount"
  >[],
): ReportRecordRow[] =>
  cookbooks.map((cookbook) => ({
    entity: "cookbook",
    id: cookbook.id,
    title: cookbook.name,
    subtitle: count(cookbook.recipeCount, "recipe"),
    trailing: null,
  }));

/**
 * A product's package-label photos. An image can be corrected from an item photo after a
 * historical cutout completed, so evidence always shows the retained original, never the old
 * transparent derivative.
 */
export const labelImageItems = (
  labels: readonly {
    id: string;
    filename: string;
    url: string;
    representations?: { original?: string | null } | null;
  }[],
): ReportRecordRow[] =>
  labels.map((label) => ({
    entity: "image",
    id: label.id,
    title: label.filename,
    subtitle: null,
    trailing: null,
    imageUrl: label.representations?.original ?? label.url,
  }));

type UsageForItems = {
  recipe: { id: string; name: string };
  sectionName?: string | null;
  amounts: readonly Amount[];
  rawLine?: string | null;
  modifier?: string | null;
};

/**
 * The recipe lines an ingredient is used in, by recipe then section: the parsed amount and
 * modifier, then the line as it was written (the evidence a re-parse is compared against).
 */
export const recipeUsageItems = (
  usages: readonly UsageForItems[],
  formatAmount: (amount: Amount) => string,
): ReportRecordRow[] =>
  [...usages].sort(compareRecipeUsages).map((usage) => ({
    entity: "recipe",
    id: usage.recipe.id,
    title: usage.recipe.name,
    subtitle: [
      [
        usage.sectionName,
        usage.amounts.map(formatAmount).join(", ") || null,
        usage.modifier,
      ]
        .filter(Boolean)
        .join(" · "),
      usage.rawLine || "(no source line)",
    ]
      .filter(Boolean)
      .join("\n"),
    trailing: null,
  }));

/** The records an image is attached to, one row each opening the record. */
export const imageAssociationItems = (
  associations: readonly ImageAssociation[],
): ReportRecordRow[] =>
  associations.map((association) => ({
    entity: association.entityKind,
    id: association.entityId,
    title: association.entityName,
    subtitle: association.role,
    trailing: null,
  }));

/** A location's latest AI description as the section's one row; none when it has none. */
export const aiDescriptionItems = (
  description: string | null | undefined,
): ReportRecordRow[] =>
  description
    ? [
        {
          entity: null,
          id: null,
          title: description,
          subtitle: null,
          trailing: null,
        },
      ]
    : [];

/** A purchase's import runs in the order given, each opening the run. */
export const runHistoryItems = (
  runs: readonly (Omit<RunSummary, "publicId"> & { publicId: string })[],
): ReportRecordRow[] =>
  runs.map((run) => ({
    entity: "run",
    id: run.publicId,
    title: run.vendorName ?? run.vendorAccountLabel ?? "Purchase import",
    subtitle: [
      [run.purpose.replaceAll("_", " "), run.trigger].join(" · "),
      [
        `${run.ordersSeen} seen`,
        `${run.imported} imported`,
        `${run.updated} updated`,
        `${run.skipped} skipped`,
      ].join(" · "),
    ].join("\n"),
    trailing: run.status,
    at: run.startedAt,
    badges: run.failureCode ? [run.failureCode] : [],
  }));
