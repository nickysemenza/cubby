/**
 * One entry per `GeneratedSuggestFieldKey` (`packages/schemas`'s
 * `control.suggest`-declared fields): what kind of Jev call the field runs
 * as, its vocabulary/roster, and how to render the subject the model sees.
 * `suggest-fields.ts` is the only reader; it resolves basis values and walks
 * this table, so adding a field is one manifest line (step 1) plus one entry
 * here — the `satisfies Record<GeneratedSuggestFieldKey, FieldSuggestSpec>`
 * below makes a missing entry a typecheck failure in both directions.
 */
import {
  entityFieldModels,
  type GeneratedSuggestFieldKey,
} from "@cubby/schemas/entity-fields";
import { type CostType, costTypeValues } from "@cubby/schemas/expense-fields";
import { gardenEntryKind, plantingStatus } from "@cubby/schemas/garden-fields";
import type { ProductId } from "@cubby/schemas/identifiers";
import { type LocationType, locationType } from "@cubby/schemas/location";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  type MealKind,
  type MealType,
  mealKindValues,
  mealTypeValues,
} from "@cubby/schemas/meal-classification";
import {
  TRADE_LABELS,
  type Trade,
  tradeValues,
  type ProjectOptionsOut,
} from "@cubby/schemas/project";
import {
  type ProjectKind,
  projectKindValues,
} from "@cubby/schemas/project-fields";

import {
  COST_TYPE_DESCRIPTIONS,
  COST_TYPE_RULES,
  LOCATION_TYPE_DESCRIPTIONS,
  LOCATION_TYPE_RULES,
  MEAL_KIND_DESCRIPTIONS,
  MEAL_KIND_RULES,
  MEAL_TYPE_DESCRIPTIONS,
  MEAL_TYPE_RULES,
  PROJECT_KIND_DESCRIPTIONS,
  PROJECT_KIND_RULES,
  TRADE_DESCRIPTIONS,
  TRADE_RULES,
} from "~/server/ai/vocabularies";
import type { Database } from "~/server/db";
import {
  getLocationPutAwayCandidates,
  type LocationPutAwayCandidate,
} from "~/server/repo/location";
import { listProductCategoryTreeOptions } from "~/server/repo/product-category";
import { projectNameOptions } from "~/server/repo/project/lookup";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { vendorOptions } from "~/server/repo/vendor";
import { locationSuggestionSpec } from "~/server/services/ai-enrichment/location-suggest";
import {
  findLexicalSearchCandidates,
  type InternalSearchCandidate,
} from "~/server/services/search.service";

import { rankCategoryCandidates } from "./category-ranking";

/** Reference keys are already replaced by the record's display name. */
export type ResolvedBasis = Readonly<Record<string, string | null>>;
/** The client-supplied basis: reference keys are still shortcodes. */
export type RawBasis = Readonly<Record<string, string | null>>;

/**
 * `V`/`C`-typed members are declared with method shorthand rather than as
 * arrow-typed properties on purpose: TypeScript checks a method signature's
 * parameter bivariantly, so `EnumSuggestSpec<ProductCategory>` (this file's
 * concrete entries) stays assignable to `FieldSuggestSpec`'s fixed
 * `EnumSuggestSpec<string>` / `ReferenceSuggestSpec<unknown>` members — an
 * arrow-typed `describe: (v: V) => string` is checked contravariantly and
 * would reject every concrete entry below.
 */
export interface EnumSuggestSpec<V extends string> {
  kind: "enum";
  values: readonly V[];
  describe(v: V): string;
  labelOf?(v: V): string;
  rules: string;
  subject(basis: ResolvedBasis): string;
}

export interface ReferenceSuggestSpec<C> {
  kind: "reference";
  /** The shortcode entity this reference field points to. */
  entity: string;
  rules: string;
  maxCandidates: number;
  roster(
    db: Database,
    basis: ResolvedBasis,
    raw: RawBasis,
  ): Promise<readonly C[]>;
  idOf(c: C): string;
  labelOf(c: C): string;
  detailOf?(c: C): string | null;
  renderLine(c: C): string;
  subject(basis: ResolvedBasis): string;
}

export interface TextRosterSuggestSpec {
  kind: "text";
  rules: string;
  maxCandidates: number;
  roster(db: Database, basis: ResolvedBasis): Promise<readonly string[]>;
  subject(basis: ResolvedBasis): string;
}

export type FieldSuggestSpec =
  | EnumSuggestSpec<string>
  | ReferenceSuggestSpec<unknown>
  | TextRosterSuggestSpec;

type AnyEntityFieldModel =
  (typeof entityFieldModels)[keyof typeof entityFieldModels];

/**
 * `Label: "value"` per non-null basis entry, in manifest field order — the
 * model prompt's subject block. Uses the field's manifest `label`, matching
 * what an operator sees on the form.
 */
function renderSubject(entity: string, basis: ResolvedBasis): string {
  // SAFETY: every `entity` passed below is a literal key this registry
  // declares an entry for, and every such entity is a real
  // `entityFieldModels` key — a typo would fail every unit test that calls
  // through `suggestFields` for that field.
  const model = (entityFieldModels as Record<string, AnyEntityFieldModel>)[
    entity
  ];
  // Widen the field list to plain `string` keys: the const-inferred manifest
  // types every entity's field keys as a giant cross-entity literal union,
  // which `Map<string, number>.get(basisKey: string)` can't be indexed by.
  const fields: readonly { key: string; label: string }[] = model?.fields ?? [];
  const order = new Map(fields.map((f, i) => [f.key, i]));
  return Object.entries(basis)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map(([key, value]) => {
      const label = fields.find((f) => f.key === key)?.label ?? key;
      return `${label}: "${value}"`;
    })
    .join("\n");
}

/** `Garage > Shelving Unit > Shelf 3`, or null at top level. Independent of
 * `location-suggest.ts`'s own private `candidatePath` (not exported). */
const locationAncestorPath = (
  candidate: LocationPutAwayCandidate,
): string | null =>
  candidate.ancestors.length > 0
    ? candidate.ancestors.map((a) => a.name).join(" > ")
    : null;

const renderProjectOption = (candidate: ProjectOptionsOut): string =>
  `${candidate.id} | ${candidate.name}`;

/**
 * DEVIATION from the plan's literal `"<id> | <name> (<kind>, <status>)"`
 * line: `projectNameOptions` (the roster this spec reuses) returns only
 * `{id, name, icon, effectiveStart, effectiveEnd}` — no `kind`/`status` — so
 * the detail line shows the effective date window instead, when there is
 * one. `rankProjectSuggestions` affinity hints are not folded in either:
 * they need per-trade expense counts this roster doesn't have, and the
 * plan allows falling back to "plain name" lines when that isn't
 * straightforward.
 */
const projectOptionDetail = (candidate: ProjectOptionsOut): string | null =>
  candidate.effectiveStart
    ? `${candidate.effectiveStart} – ${candidate.effectiveEnd ?? "ongoing"}`
    : null;

/** Rosters bounded well under `JEV_MAX_CANDIDATES` (254): the decision tier
 * is the common case, and only a very large household ever overflows to the
 * fast-tier selection feature. */
const REFERENCE_ROSTER_CAP = 200;
/** Vendor names: small enough Jev sees the whole household roster. */
const VENDOR_ROSTER_CAP = 200;
/** A text basis shorter than this is too little signal to search on. */
const MIN_SEARCH_TEXT_LENGTH = 3;

async function lexicalProductCandidates(
  db: Database,
  query: string | null,
): Promise<readonly InternalSearchCandidate[]> {
  const trimmed = query?.trim() ?? "";
  if (trimmed.length < MIN_SEARCH_TEXT_LENGTH) return [];
  return findLexicalSearchCandidates(
    db,
    { query: trimmed, entityTypes: ["product"], limit: REFERENCE_ROSTER_CAP },
    REFERENCE_ROSTER_CAP,
  );
}

const renderProductCandidate = (candidate: InternalSearchCandidate): string =>
  `${candidate.id} | ${candidate.title}${
    candidate.subtitle ? ` — ${candidate.subtitle}` : ""
  }`;

type ProductCategorySuggestionOption = Awaited<
  ReturnType<typeof listProductCategoryTreeOptions>
>[number] & {
  aliases?: readonly string[];
  description?: string | null;
};

const productCategoryPath = (
  candidate: ProductCategorySuggestionOption,
): string => candidate.path.map(({ name }) => name).join(" > ");

/** Give Jev every lexical handle attached to a category, while keeping the
 * hierarchy visible so a similarly named leaf is never selected in isolation. */
const renderProductCategoryOption = (
  candidate: ProductCategorySuggestionOption,
): string => {
  const aliases = candidate.aliases?.filter(Boolean).join(", ");
  return [
    `${candidate.id} | ${productCategoryPath(candidate)}`,
    aliases ? `aliases: ${aliases}` : null,
    candidate.description ? `description: ${candidate.description}` : null,
  ]
    .filter((part): part is string => part != null)
    .join(" — ");
};

export const FIELD_SUGGEST_REGISTRY = {
  "planting.status": {
    kind: "enum",
    values: plantingStatus.options,
    describe: (v) =>
      ({
        planned: "Planned for a future or not-yet-established planting",
        growing: "Currently transplanted or actively growing",
        finished: "No longer growing or completed",
      })[v],
    rules:
      "Infer the planting lifecycle status from its dates. A transplant date indicates growing; a finished date indicates finished; otherwise choose planned.",
    subject: (basis) => renderSubject("planting", basis),
  } satisfies EnumSuggestSpec<"planned" | "growing" | "finished">,
  "gardenEntry.kind": {
    kind: "enum",
    values: gardenEntryKind.options,
    describe: (v) =>
      v === "harvest"
        ? "A record of gathered produce"
        : "A note, observation, or photo record",
    rules:
      "Choose harvest when a harvest amount is present; otherwise choose note for an observation or photo journal entry.",
    subject: (basis) => renderSubject("gardenEntry", basis),
  } satisfies EnumSuggestSpec<"note" | "harvest">,
  "product.categoryId": {
    kind: "reference",
    entity: "productCategory",
    rules:
      "You are a household-product classifier. Choose the ONE most specific existing classification supported by the product evidence. Compare the complete hierarchy, names, aliases, and descriptions. Choose none when the evidence does not support a classification; never invent a category.",
    // Categories are a taxonomy rather than a household-sized roster. Show
    // every live node; `runAiSelection` uses its overflow path above Jev's
    // choice limit instead of silently dropping broad roots or their leaves.
    maxCandidates: Number.MAX_SAFE_INTEGER,
    roster: async (db, basis) =>
      rankCategoryCandidates(await listProductCategoryTreeOptions(db), basis),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: (c) => productCategoryPath(c),
    renderLine: renderProductCategoryOption,
    subject: (basis) => renderSubject("product", basis),
  } satisfies ReferenceSuggestSpec<ProductCategorySuggestionOption>,
  "location.type": {
    kind: "enum",
    values: locationType.options,
    describe: (v) => LOCATION_TYPE_DESCRIPTIONS[v],
    rules: LOCATION_TYPE_RULES,
    subject: (basis) => renderSubject("location", basis),
  } satisfies EnumSuggestSpec<LocationType>,
  "inventory.locationId": {
    kind: "reference",
    entity: "location",
    rules: locationSuggestionSpec.rules,
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: async (db, _basis, raw) => {
      const productShortcode = raw.productId;
      if (!productShortcode) return [];
      const productId: ProductId | null = await resolveLiveShortcode(
        db,
        productShortcode,
        "product",
      );
      if (!productId) return [];
      return getLocationPutAwayCandidates(db, productId);
    },
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: locationAncestorPath,
    renderLine: locationSuggestionSpec.renderLine,
    subject: (basis) => renderSubject("inventory", basis),
  } satisfies ReferenceSuggestSpec<LocationPutAwayCandidate>,
  "project.kind": {
    kind: "enum",
    values: projectKindValues,
    describe: (v) => PROJECT_KIND_DESCRIPTIONS[v],
    rules: PROJECT_KIND_RULES,
    subject: (basis) => renderSubject("project", basis),
  } satisfies EnumSuggestSpec<ProjectKind>,
  "meal.mealType": {
    kind: "enum",
    values: mealTypeValues,
    describe: (v) => MEAL_TYPE_DESCRIPTIONS[v],
    labelOf: (v) => MEAL_TYPE_LABELS[v],
    rules: MEAL_TYPE_RULES,
    subject: (basis) => renderSubject("meal", basis),
  } satisfies EnumSuggestSpec<MealType>,
  "meal.mealKind": {
    kind: "enum",
    values: mealKindValues,
    describe: (v) => MEAL_KIND_DESCRIPTIONS[v],
    labelOf: (v) => MEAL_KIND_LABELS[v],
    rules: MEAL_KIND_RULES,
    subject: (basis) => renderSubject("meal", basis),
  } satisfies EnumSuggestSpec<MealKind>,
  "task.projectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given a task and the household's projects, choose the ONE project it belongs to, or none if it stands alone.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: (db) => projectNameOptions(db),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderProjectOption,
    subject: (basis) => renderSubject("task", basis),
  } satisfies ReferenceSuggestSpec<ProjectOptionsOut>,
  "task.subjectProductId": {
    kind: "reference",
    entity: "product",
    rules:
      "You are a product-linking assistant. Given a task's name, choose the ONE product it is about, or none if it isn't about a specific product.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: (db, basis) => lexicalProductCandidates(db, basis.name ?? null),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: renderProductCandidate,
    subject: (basis) => renderSubject("task", basis),
  } satisfies ReferenceSuggestSpec<InternalSearchCandidate>,
  "task.trade": {
    kind: "enum",
    values: tradeValues,
    describe: (v) => TRADE_DESCRIPTIONS[v],
    labelOf: (v) => TRADE_LABELS[v],
    rules: TRADE_RULES,
    subject: (basis) => renderSubject("task", basis),
  } satisfies EnumSuggestSpec<Trade>,
  "expense.costType": {
    kind: "enum",
    values: costTypeValues,
    describe: (v) => COST_TYPE_DESCRIPTIONS[v],
    rules: COST_TYPE_RULES,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies EnumSuggestSpec<CostType>,
  "expense.trade": {
    kind: "enum",
    values: tradeValues,
    describe: (v) => TRADE_DESCRIPTIONS[v],
    labelOf: (v) => TRADE_LABELS[v],
    rules: TRADE_RULES,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies EnumSuggestSpec<Trade>,
  // No `trade` in this basis: `expense.trade`'s own basis includes
  // `projectId`, so the reverse edge would make the pair cyclic — rejected
  // by the manifest compiler (step 1).
  "expense.projectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given an expense and the household's projects, choose the ONE project it belongs to, or none if it isn't tied to a project.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: (db) => projectNameOptions(db),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderProjectOption,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies ReferenceSuggestSpec<ProjectOptionsOut>,
  "expense.productId": {
    kind: "reference",
    entity: "product",
    rules:
      "You are a product-linking assistant. Given an expense's name, choose the ONE product it is for, or none if it isn't about a specific product.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: (db, basis) => lexicalProductCandidates(db, basis.name ?? null),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: renderProductCandidate,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies ReferenceSuggestSpec<InternalSearchCandidate>,
  "expense.vendor": {
    kind: "text",
    rules:
      "You are a vendor-matching assistant. Given an expense's name, notes, and order id, choose the ONE existing vendor it was bought from, or none if no listed vendor fits.",
    maxCandidates: VENDOR_ROSTER_CAP,
    roster: async (db) => {
      const vendors = await vendorOptions(db);
      return vendors.slice(0, VENDOR_ROSTER_CAP).map((v) => v.name);
    },
    subject: (basis) => renderSubject("expense", basis),
  } satisfies TextRosterSuggestSpec,
} satisfies Record<GeneratedSuggestFieldKey, FieldSuggestSpec>;

export function fieldSuggestSpecFor(
  entity: string,
  field: string,
): FieldSuggestSpec | undefined {
  const key = `${entity}.${field}`;
  // SAFETY: `Object.hasOwn` just proved `key` names one of
  // `FIELD_SUGGEST_REGISTRY`'s own declared keys, not an arbitrary string.
  return Object.hasOwn(FIELD_SUGGEST_REGISTRY, key)
    ? FIELD_SUGGEST_REGISTRY[key as keyof typeof FIELD_SUGGEST_REGISTRY]
    : undefined;
}
