/**
 * One entry per `GeneratedSuggestFieldKey` (`packages/schemas`'s
 * `control.suggest`-declared fields): what kind of decision call the field runs
 * as, its vocabulary/roster, and how to render the subject the model sees.
 * The declarative half lives in `ai/policy/field-suggest.ts`; each entry here
 * spreads it and adds the database-backed roster or candidates.
 * `suggest-fields.ts` is the only reader; it resolves basis values and walks
 * this table, so adding a field is one manifest line (step 1) plus one entry
 * in each file — the `satisfies Record<Exclude<GeneratedSuggestFieldKey, `${string}.emoji`>, FieldSuggestSpec>`
 * below makes a missing entry a typecheck failure in both directions.
 */
import {
  entityFieldModels,
  type GeneratedSuggestFieldKey,
} from "@cubby/schemas/entity-fields";
import type { ProductId } from "@cubby/schemas/identifiers";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import {
  TRADE_LABELS,
  type Trade,
  type ProjectOptionsOut,
} from "@cubby/schemas/project";
import {
  spendingCategoryFilters,
  type SpendingCategoryOut,
} from "@cubby/schemas/spending-category";
import { isCollectionTag } from "@cubby/shared/collection-tag";
import {
  redundantTokens,
  type RedundantTokenMatch,
} from "@cubby/shared/redundant-tokens";
import { z } from "zod";

import {
  type ArrayPruneSuggestDecision,
  emojiDecision,
  type EnumSuggestDecision,
  type EnumSuggestKey,
  FIELD_SUGGEST_DECISIONS,
  INGREDIENT_ROSTER_CAP,
  type RawBasis,
  REFERENCE_ROSTER_CAP,
  type ReferenceSuggestDecision,
  type ResolvedBasis,
  type TextRosterSuggestDecision,
  VENDOR_ROSTER_CAP,
} from "~/server/ai/policy/field-suggest";
import { locationSuggestionSpec } from "~/server/ai/policy/prompts/location-suggest";
import type { Database } from "~/server/db";
import { expenseTradeAffinity } from "~/server/domains/expense/repo/analytics";
import {
  getLocationPutAwayCandidates,
  type LocationPutAwayCandidate,
} from "~/server/domains/location/repo/lookup";
import {
  listBoundCategoryFeatures,
  listProductCategoryTreeOptions,
} from "~/server/domains/product-category/repo/product-category";
import { projectNameOptions } from "~/server/domains/project/repo/lookup";
import { listSpendingCategories } from "~/server/domains/spending-category/repo/spending-category";
import { vendorOptions } from "~/server/domains/vendor/repo/vendor";
import { semanticEntityCandidates } from "~/server/generic/embedding/service/semantic-search.service";
import {
  findLexicalSearchCandidates,
  type InternalSearchCandidate,
} from "~/server/generic/search/service/search.service";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { rankCategoryCandidates } from "./category-ranking";

/**
 * `V`/`C`-typed members use method shorthand on purpose: TypeScript checks a
 * method signature's parameter bivariantly, so this file's concrete entries
 * stay assignable to `FieldSuggestSpec`'s fixed `EnumSuggestSpec<string>` /
 * `ReferenceSuggestSpec<unknown>` members.
 */
interface EnumSuggestSpec<V extends string> extends EnumSuggestDecision<V> {
  /** Narrows `values` for this record; an empty result skips the target
   * without asking the decision model (nothing admissible to suggest). */
  candidates?(db: Database, raw: RawBasis): Promise<readonly V[]>;
}

export interface ReferenceSuggestSpec<C> extends ReferenceSuggestDecision {
  roster(
    db: Database,
    basis: ResolvedBasis,
    raw: RawBasis,
  ): Promise<readonly C[]>;
  idOf(c: C): string;
  labelOf(c: C): string;
  detailOf?(c: C): string | null;
  renderLine(c: C): string;
  /** A tree roster's parent link, used to suppress ancestor corrections. */
  parentIdOf?(c: C): string | null;
}

interface TextRosterSuggestSpec extends TextRosterSuggestDecision {
  roster(db: Database, basis: ResolvedBasis): Promise<readonly string[]>;
}

/**
 * A `control.suggest.mode: "prune"` target: instead of picking a value, it
 * proposes *removing* entries from its own current array (an implicit
 * self-basis — `docs/entities.md`). `suggest-fields.ts`'s `resolvePruneTarget`
 * is the only reader: it parses the self-basis JSON array via `candidates`,
 * asks `deterministic` for the subset `redundantTokens` already flags at
 * probability 1, then spends at most `maxDecisionCandidates` per-tag decision binary
 * calls (`rules` + `subject`) on the rest.
 */
export interface ArrayPruneSuggestSpec extends ArrayPruneSuggestDecision {
  /** Every current entry eligible for pruning: the self-basis array minus
   * `collection:*` (Collections' own namespace, never a prune candidate). */
  candidates(basis: ResolvedBasis, raw: RawBasis): readonly string[];
  /** The subset of `candidates(...)` already redundant with no decision call. */
  deterministic(
    basis: ResolvedBasis,
    raw: RawBasis,
    db: Database,
  ): Promise<readonly RedundantTokenMatch[]>;
}

export type FieldSuggestSpec =
  | EnumSuggestSpec<string>
  | ReferenceSuggestSpec<unknown>
  | TextRosterSuggestSpec
  | ArrayPruneSuggestSpec;

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

/** A project option plus its per-trade expense history. */
interface ExpenseProjectOption extends ProjectOptionsOut {
  tradeAffinity: readonly { trade: Trade; count: number }[];
}

/**
 * The expense→project roster carries the same project × trade matrix
 * `rankProjectSuggestions` weights by. The basis cannot include the
 * expense's own `trade` (the reverse edge of `expense.trade`'s basis would
 * be cyclic), so each line lists the project's trade tallies and the decision model matches
 * the expense against them.
 */
async function expenseProjectRoster(
  db: Database,
): Promise<ExpenseProjectOption[]> {
  const [projects, affinity] = await Promise.all([
    projectNameOptions(db),
    expenseTradeAffinity(db),
  ]);
  const byProject = new Map<string, { trade: Trade; count: number }[]>();
  for (const cell of affinity) {
    const cells = byProject.get(cell.projectId) ?? [];
    cells.push({ trade: cell.trade, count: cell.count });
    byProject.set(cell.projectId, cells);
  }
  return projects.map((project) => ({
    ...project,
    tradeAffinity: byProject.get(project.id) ?? [],
  }));
}

/** Most-charged trade first, so the line leads with the project's strongest
 * signal. */
const renderExpenseProjectOption = (candidate: ExpenseProjectOption): string =>
  candidate.tradeAffinity.length === 0
    ? renderProjectOption(candidate)
    : `${renderProjectOption(candidate)} — expenses by trade: ${[
        ...candidate.tradeAffinity,
      ]
        .sort((a, b) => b.count - a.count || a.trade.localeCompare(b.trade))
        .map(({ trade, count }) => `${TRADE_LABELS[trade]} ${count}`)
        .join(", ")}`;

/**
 * DEVIATION from the plan's literal `"<id> | <name> (<kind>, <status>)"`
 * line: `projectNameOptions` (the roster this spec reuses) returns only
 * `{id, name, icon, effectiveStart, effectiveEnd}` — no `kind`/`status` — so
 * the detail line shows the effective date window instead, when there is
 * one.
 */
const projectOptionDetail = (candidate: ProjectOptionsOut): string | null =>
  candidate.effectiveStart
    ? `${candidate.effectiveStart} – ${candidate.effectiveEnd ?? "ongoing"}`
    : null;

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
    { query: trimmed, entityKinds: ["product"], limit: REFERENCE_ROSTER_CAP },
    REFERENCE_ROSTER_CAP,
  );
}

interface LinkedEntityCandidate {
  id: string;
  title: string;
  subtitle: string | null;
}

/** Lexical prefix search ANDs every term (`buildPrefixTsQuery`), so a full
 * product name rarely matches a short ingredient or plant; semantic
 * neighbours of the name carry the roster, and lexical hits on the name are
 * added when present. */
async function linkedCandidatesForProduct(
  db: Database,
  name: string | null,
  entityKind: "ingredient" | "plant",
): Promise<readonly LinkedEntityCandidate[]> {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length < MIN_SEARCH_TEXT_LENGTH) return [];
  const [semantic, lexical] = await Promise.all([
    semanticEntityCandidates(db, trimmed, INGREDIENT_ROSTER_CAP, entityKind),
    findLexicalSearchCandidates(
      db,
      {
        query: trimmed,
        entityKinds: [entityKind],
        limit: INGREDIENT_ROSTER_CAP,
      },
      INGREDIENT_ROSTER_CAP,
    ),
  ]);
  const byId = new Map<string, LinkedEntityCandidate>();
  for (const candidate of [...semantic.map(({ item }) => item), ...lexical]) {
    if (!byId.has(candidate.id))
      byId.set(candidate.id, {
        id: candidate.id,
        title: candidate.title,
        subtitle: candidate.subtitle,
      });
  }
  return [...byId.values()].slice(0, INGREDIENT_ROSTER_CAP);
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

/** Give the decision model every lexical handle attached to a category, while keeping the
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

const jsonStringArraySchema = z.array(z.string());

/** Parses a JSON-encoded string array from a basis value (self-basis tags,
 * or a sibling text-array basis field like `aliases`); `null`/invalid JSON/a
 * non-array shape all read as "no signal" rather than throwing — a raw basis
 * value is untrusted client input. */
function parseJsonStringArray(
  raw: string | null | undefined,
): readonly string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = jsonStringArraySchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** `raw[arrayKey]`'s current entries minus `collection:*` (Collections' own
 * namespace, never a prune candidate) — every `ArrayPruneSuggestSpec`'s
 * `candidates` is this same parse, so it is factored out once. */
function pruneCandidates(raw: RawBasis, arrayKey: string): readonly string[] {
  return (parseJsonStringArray(raw[arrayKey] ?? null) ?? []).filter(
    (value) => !isCollectionTag(value),
  );
}

type SpendingCategoryCandidate = SpendingCategoryOut & { path: string };

async function spendingCategoryRoster(
  db: Database,
): Promise<SpendingCategoryCandidate[]> {
  const rows: SpendingCategoryOut[] = [];
  for (let pageIndex = 0; ; pageIndex++) {
    const page = await listSpendingCategories(
      db,
      spendingCategoryFilters.parse({}),
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex, pageSize: MAX_PAGE_SIZE },
    );
    rows.push(...page.data);
    if (rows.length >= page.count || page.data.length === 0) break;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.map((row) => {
    const names = [row.name];
    const seen = new Set([row.id]);
    let parentId = row.parentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return { ...row, path: names.join(" > ") };
  });
}

const spendingCategoryRuntime = {
  roster: spendingCategoryRoster,
  idOf: (c: SpendingCategoryCandidate) => c.id,
  labelOf: (c: SpendingCategoryCandidate) => c.name,
  detailOf: (c: SpendingCategoryCandidate) => c.path,
  renderLine: (c: SpendingCategoryCandidate) => `${c.id} | ${c.path}`,
  parentIdOf: (c: SpendingCategoryCandidate) => c.parentId,
};

const FIELD_SUGGEST_OVERRIDES = {
  "vendor.defaultSpendingCategoryId": {
    ...FIELD_SUGGEST_DECISIONS["vendor.defaultSpendingCategoryId"],
    ...spendingCategoryRuntime,
  },
  "purchase.spendingCategoryId": {
    ...FIELD_SUGGEST_DECISIONS["purchase.spendingCategoryId"],
    ...spendingCategoryRuntime,
  } satisfies ReferenceSuggestSpec<SpendingCategoryCandidate>,
  "expense.spendingCategoryId": {
    ...FIELD_SUGGEST_DECISIONS["expense.spendingCategoryId"],
    ...spendingCategoryRuntime,
  } satisfies ReferenceSuggestSpec<SpendingCategoryCandidate>,
  "product.categoryId": {
    ...FIELD_SUGGEST_DECISIONS["product.categoryId"],
    roster: async (db, basis) =>
      rankCategoryCandidates(await listProductCategoryTreeOptions(db), basis),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: (c) => productCategoryPath(c),
    renderLine: renderProductCategoryOption,
    parentIdOf: (c) => c.ancestorIds.at(-1) ?? null,
  } satisfies ReferenceSuggestSpec<ProductCategorySuggestionOption>,
  "product.ingredientId": {
    ...FIELD_SUGGEST_DECISIONS["product.ingredientId"],
    roster: (db, basis) =>
      linkedCandidatesForProduct(db, basis.name ?? null, "ingredient"),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: (c) =>
      `${c.id} | ${c.title}${c.subtitle ? ` — ${c.subtitle}` : ""}`,
  } satisfies ReferenceSuggestSpec<LinkedEntityCandidate>,
  "product.growsPlantId": {
    ...FIELD_SUGGEST_DECISIONS["product.growsPlantId"],
    roster: (db, basis) =>
      linkedCandidatesForProduct(db, basis.name ?? null, "plant"),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: (c) =>
      `${c.id} | ${c.title}${c.subtitle ? ` — ${c.subtitle}` : ""}`,
  } satisfies ReferenceSuggestSpec<LinkedEntityCandidate>,
  "product.tags": {
    ...FIELD_SUGGEST_DECISIONS["product.tags"],
    candidates: (_basis, raw) => pruneCandidates(raw, "tags"),
    // `raw.categoryId` is the still-unresolved shortcode (`RawBasis`, unlike
    // `basis.categoryId`'s display label) — the same raw-shortcode-lookup
    // shape as `inventory.locationId`'s `productId` above. Reuses
    // `product.categoryId`'s own roster fetch rather than a new query: the
    // taxonomy is small (29 nodes today) and already loaded for that target
    // when both are requested together.
    deterministic: async (basis, raw, db) => {
      const values = pruneCandidates(raw, "tags");
      if (values.length === 0) return [];
      const categoryShortcode = raw.categoryId ?? null;
      const category = categoryShortcode
        ? (await listProductCategoryTreeOptions(db)).find(
            (option) => option.id === categoryShortcode,
          )
        : null;
      return redundantTokens({
        values,
        restating: {
          manufacturer: basis.manufacturer,
          classification: category?.path.map((node) => node.name) ?? null,
          feature: category?.feature ?? null,
          alias: parseJsonStringArray(basis.aliases),
        },
      });
    },
  } satisfies ArrayPruneSuggestSpec,
  "inventory.locationId": {
    ...FIELD_SUGGEST_DECISIONS["inventory.locationId"],
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
  } satisfies ReferenceSuggestSpec<LocationPutAwayCandidate>,
  "task.projectId": {
    ...FIELD_SUGGEST_DECISIONS["task.projectId"],
    roster: (db) => projectNameOptions(db),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderProjectOption,
  } satisfies ReferenceSuggestSpec<ProjectOptionsOut>,
  "task.subjectProductId": {
    ...FIELD_SUGGEST_DECISIONS["task.subjectProductId"],
    roster: (db, basis) => lexicalProductCandidates(db, basis.name ?? null),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: renderProductCandidate,
  } satisfies ReferenceSuggestSpec<InternalSearchCandidate>,
  "expense.projectId": {
    ...FIELD_SUGGEST_DECISIONS["expense.projectId"],
    roster: expenseProjectRoster,
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderExpenseProjectOption,
  } satisfies ReferenceSuggestSpec<ExpenseProjectOption>,
  "expense.productId": {
    ...FIELD_SUGGEST_DECISIONS["expense.productId"],
    roster: (db, basis) => lexicalProductCandidates(db, basis.name ?? null),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: renderProductCandidate,
  } satisfies ReferenceSuggestSpec<InternalSearchCandidate>,
  "expense.vendor": {
    ...FIELD_SUGGEST_DECISIONS["expense.vendor"],
    roster: async (db) => {
      const vendors = await vendorOptions(db);
      return vendors.slice(0, VENDOR_ROSTER_CAP).map((v) => v.name);
    },
  } satisfies TextRosterSuggestSpec,
  "purchase.vendorId": {
    ...FIELD_SUGGEST_DECISIONS["purchase.vendorId"],
    roster: async (db) => {
      const vendors = await vendorOptions(db);
      return vendors.slice(0, VENDOR_ROSTER_CAP).map((v) => ({
        id: v.id,
        name: v.name,
      }));
    },
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    renderLine: (c) => `${c.id} | ${c.name}`,
  } satisfies ReferenceSuggestSpec<{ id: string; name: string }>,
  "purchase.defaultProjectId": {
    ...FIELD_SUGGEST_DECISIONS["purchase.defaultProjectId"],
    roster: (db) => projectNameOptions(db),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderProjectOption,
  } satisfies ReferenceSuggestSpec<ProjectOptionsOut>,
} satisfies Record<
  Exclude<GeneratedSuggestFieldKey, EnumSuggestKey | `${string}.emoji`>,
  FieldSuggestSpec
>;

const PRODUCT_CATEGORY_FEATURE =
  FIELD_SUGGEST_DECISIONS["productCategory.feature"];

export const FIELD_SUGGEST_REGISTRY = {
  ...FIELD_SUGGEST_DECISIONS,
  "productCategory.feature": {
    ...PRODUCT_CATEGORY_FEATURE,
    candidates: async (db, raw) => {
      if (raw.parentId) return [];
      const bound: Set<string> = new Set(await listBoundCategoryFeatures(db));
      return PRODUCT_CATEGORY_FEATURE.values.filter(
        (value) => !bound.has(value),
      );
    },
  } satisfies EnumSuggestSpec<string>,
  ...FIELD_SUGGEST_OVERRIDES,
} satisfies Record<
  Exclude<GeneratedSuggestFieldKey, `${string}.emoji`>,
  FieldSuggestSpec
>;

export function fieldSuggestSpecFor(
  entity: string,
  field: string,
): FieldSuggestSpec | undefined {
  if (field === "emoji" && Object.hasOwn(entityFieldModels, entity))
    return emojiDecision(entity);
  const key = `${entity}.${field}`;
  // SAFETY: `Object.hasOwn` just proved `key` names one of
  // `FIELD_SUGGEST_REGISTRY`'s own declared keys, not an arbitrary string.
  if (!Object.hasOwn(FIELD_SUGGEST_REGISTRY, key)) return undefined;
  // SAFETY: Object.hasOwn above proves this dynamic key belongs to the
  // registry, while TypeScript retains only its full literal union.
  const spec =
    FIELD_SUGGEST_REGISTRY[key as keyof typeof FIELD_SUGGEST_REGISTRY];
  return spec;
}
