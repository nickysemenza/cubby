import type { Amount } from "@cubby/schemas/codec";
import type {
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import type { ImageAssociation } from "@cubby/schemas/image";
import type { ProductCookbookRefOut } from "@cubby/schemas/product";
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
    subtitle: null,
    // The count doubles as the link to the recipes taken from this cookbook.
    trailing: count(cookbook.recipeCount, "recipe"),
    listLink: { entity: "recipe", filters: { source: cookbook.id } },
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
  /** Labels whose detected nutrition is new and unsaved: the server's one rule for the review verb. */
  reviewable: ReadonlySet<string> = new Set(),
): ReportRecordRow[] =>
  labels.map((label) => ({
    entity: "image",
    id: label.id,
    title: label.filename,
    subtitle: null,
    trailing: null,
    imageUrl: label.representations?.original ?? label.url,
    actions: reviewable.has(label.id) ? ["reviewLabelNutrition"] : [],
  }));

/** Recipe, then section, then the written line, so a repeated recipe keeps a stable order. */
const compareUsages = (a: UsageForItems, b: UsageForItems) =>
  a.recipe.name.localeCompare(b.recipe.name) ||
  a.recipe.id.localeCompare(b.recipe.id) ||
  (a.sectionName ?? "").localeCompare(b.sectionName ?? "") ||
  (a.rawLine ?? "").localeCompare(b.rawLine ?? "");

export type UsageForItems = {
  /** The recipe line's row id, the handle a re-parse of that one line needs. */
  id: string;
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
  /** Badges for a line a fresh parse would change, composed by the caller (it owns the parser). */
  badgesOf: (usage: UsageForItems) => string[] = () => [],
  /** What the person can do to a line (re-parse it), composed by the caller. */
  commandsOf: (usage: UsageForItems) => ReportCommand[] = () => [],
): ReportRecordRow[] =>
  [...usages].sort(compareUsages).map((usage) => ({
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
    badges: badgesOf(usage),
    commands: commandsOf(usage),
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
