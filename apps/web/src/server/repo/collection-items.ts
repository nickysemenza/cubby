import type { Amount } from "@cubby/schemas/codec";
import type {
  ReportCommand,
  ReportRecordRow,
  ReportRowState,
} from "@cubby/schemas/entity-report";
import type { ImageAssociation } from "@cubby/schemas/image";
import type { ProductCookbookRefOut } from "@cubby/schemas/product";
import type { RunSummary } from "@cubby/schemas/run";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";

/**
 * Rows for `collection` detail sections (`presentation.detail.sections`, kind `collection`).
 * Each backs one section: web and native list exactly these rows, so a count, a role or a line
 * of text is worded once, here. Kept free of the formatting/WASM modules so the repositories that
 * attach the rows to a record stay light on the request path.
 */

export const phaseLabel = (phase: string) =>
  phase.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES);

/** A run, phase or operation status as a row state; undefined while it means nothing settled. */
export const runRowState = (status: string): ReportRowState | undefined => {
  if (status === "completed" || status === "succeeded") return "done";
  if (["failed", "cancelled", "aborted", "dispatch_failed"].includes(status))
    return "failed";
  if (status.startsWith("paused")) return "warning";
  if (status === "started" || LIVE_RUN_STATUSES.has(status)) return "running";
  return undefined;
};

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
    // The count doubles as the link to the recipes taken from this cookbook.
    trailing: countLabel(cookbook.recipeCount, "recipe"),
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
  badgesOf: (usage: UsageForItems) => ReportRecordRow["badges"] = () => [],
  /** What the person can do to a line (re-parse it), composed by the caller. */
  commandsOf: (usage: UsageForItems) => ReportCommand[] = () => [],
): ReportRecordRow[] =>
  [...usages].sort(compareUsages).map((usage) => ({
    entity: "recipe",
    id: usage.recipe.id,
    title: usage.recipe.name,
    lines: [
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
      .map((text) => ({ text, tone: "muted" as const })),
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
    lines: association.role ? [{ text: association.role, tone: "muted" }] : [],
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
    lines: [
      { text: [run.purpose.replaceAll("_", " "), run.trigger].join(" · ") },
      {
        text: [
          `${run.ordersSeen} seen`,
          `${run.imported} imported`,
          `${run.updated} updated`,
          `${run.skipped} skipped`,
        ].join(" · "),
        tone: "muted",
      },
    ],
    trailing: null,
    at: run.startedAt,
    ...withState(run.status),
    badges: run.failureCode
      ? [{ label: run.failureCode, tone: "warning" }]
      : [],
  }));

/** The row's `state` for a run status that has one; any other status stays its trailing text. */
const withState = (status: string) => {
  const kind = runRowState(status);
  return kind
    ? { state: { kind, label: phaseLabel(status) } }
    : { trailing: phaseLabel(status) };
};
