import { emojiCandidates } from "@cubby/schemas/emoji";
/**
 * One entry per `GeneratedSuggestFieldKey` (`packages/schemas`'s
 * `control.suggest`-declared fields): what kind of Jev call the field runs
 * as, its vocabulary/roster, and how to render the subject the model sees.
 * `suggest-fields.ts` is the only reader; it resolves basis values and walks
 * this table, so adding a field is one manifest line (step 1) plus one entry
 * here — the `satisfies Record<Exclude<GeneratedSuggestFieldKey, `${string}.emoji`>, FieldSuggestSpec>`
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

import type { Database } from "~/server/db";
import { expenseTradeAffinity } from "~/server/repo/expense/analytics";
import {
  getLocationPutAwayCandidates,
  type LocationPutAwayCandidate,
} from "~/server/repo/location/lookup";
import {
  listBoundCategoryFeatures,
  listProductCategoryTreeOptions,
} from "~/server/repo/product-category";
import { projectNameOptions } from "~/server/repo/project/lookup";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { listSpendingCategories } from "~/server/repo/spending-category";
import { vendorOptions } from "~/server/repo/vendor";
import { locationSuggestionSpec } from "~/server/services/ai-enrichment/location-suggest";
import {
  findLexicalSearchCandidates,
  type InternalSearchCandidate,
} from "~/server/services/search.service";
import { semanticEntityCandidates } from "~/server/services/semantic-search.service";

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
interface EnumSuggestSpec<V extends string> {
  kind: "enum";
  values: readonly V[];
  /** Narrows `values` for this record; an empty result skips the target
   * without asking Jev (nothing admissible to suggest). */
  candidates?(db: Database, raw: RawBasis): Promise<readonly V[]>;
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
  /** A tree roster's parent link. When set, a pick below the high-confidence
   * floor rolls up to the deepest ancestor whose subtree clears it
   * (`placeByBranch`). */
  parentIdOf?(c: C): string | null;
}

interface TextRosterSuggestSpec {
  kind: "text";
  rules: string;
  maxCandidates: number;
  roster(db: Database, basis: ResolvedBasis): Promise<readonly string[]>;
  subject(basis: ResolvedBasis): string;
}

/**
 * A `control.suggest.mode: "prune"` target: instead of picking a value, it
 * proposes *removing* entries from its own current array (an implicit
 * self-basis — `docs/entities.md`). `suggest-fields.ts`'s `resolvePruneTarget`
 * is the only reader: it parses the self-basis JSON array via `candidates`,
 * asks `deterministic` for the subset `redundantTokens` already flags at
 * probability 1, then spends at most `maxJevCandidates` per-tag Jev binary
 * calls (`rules` + `subject`) on the rest.
 */
export interface ArrayPruneSuggestSpec {
  kind: "prune";
  rules: string;
  /** The target field's own manifest key (e.g. `"tags"`) — where the
   * self-basis JSON array lives in `raw`. */
  arrayKey: string;
  /** Caps the per-survivor Jev calls a large ad-hoc tag list could incur. */
  maxJevCandidates: number;
  /** Every current entry eligible for pruning: the self-basis array minus
   * `collection:*` (Collections' own namespace, never a prune candidate). */
  candidates(basis: ResolvedBasis, raw: RawBasis): readonly string[];
  /** The subset of `candidates(...)` already redundant with no Jev call. */
  deterministic(
    basis: ResolvedBasis,
    raw: RawBasis,
    db: Database,
  ): Promise<readonly RedundantTokenMatch[]>;
  /** One survivor tag's Jev subject line. */
  subject(basis: ResolvedBasis, value: string): string;
}

export type FieldSuggestSpec =
  | EnumSuggestSpec<string>
  | ReferenceSuggestSpec<unknown>
  | TextRosterSuggestSpec
  | ArrayPruneSuggestSpec;

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

/** A project option plus its per-trade expense history. */
interface ExpenseProjectOption extends ProjectOptionsOut {
  tradeAffinity: readonly { trade: Trade; count: number }[];
}

/**
 * The expense→project roster carries the same project × trade matrix
 * `rankProjectSuggestions` weights by. The basis cannot include the
 * expense's own `trade` (the reverse edge of `expense.trade`'s basis would
 * be cyclic), so each line lists the project's trade tallies and Jev matches
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

/** Rosters bounded well under `JEV_MAX_CANDIDATES` (254): the decision tier
 * is the common case, and only a very large household ever overflows to the
 * fast-tier selection feature. */
const REFERENCE_ROSTER_CAP = 200;
/** Vendor names: small enough Jev sees the whole household roster. */
const VENDOR_ROSTER_CAP = 200;
/** Semantic neighbours of a product name; the right ingredient is near the top. */
const INGREDIENT_ROSTER_CAP = 25;
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

/** `product.tags`'s subject line: the shared product subject plus the one
 * candidate tag under review — `ArrayPruneSuggestSpec.subject` is called once
 * per survivor, not once per request. */
const productTagPruneSubject = (basis: ResolvedBasis, value: string): string =>
  `${renderSubject("product", basis)}\nCandidate tag: "${value}"`;

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

function spendingCategorySpec(
  entity: "purchase" | "expense" | "vendor",
): ReferenceSuggestSpec<SpendingCategoryCandidate> {
  return {
    kind: "reference",
    entity: "spendingCategory",
    maxCandidates: Number.MAX_SAFE_INTEGER,
    rules:
      (entity === "purchase"
        ? "This proposal changes an explicit fallback only; it never classifies all linked Expense lines or replaces mixed line classifications. "
        : "Classify this Expense line only, using its own purpose and Product evidence. Preserve adjustment and reimbursement roles; a transaction link alone supplies no item-dollar attribution. ") +
      "Choose the most specific existing spending category supported by the transaction or purchase evidence. Saved linked evidence preserves signed amounts, principal versus adjustment lines, reimbursement roles and split settlements. When saved purpose or linked spending clearly identifies what a reimbursement repays, choose that original spending category (for example restaurant dinner), without treating the reimbursement as new purchased goods. A payment provider name, credit/debit direction, or income/refund kind alone cannot establish that purpose. Do not count tax, shipping, refunds or reimbursements as separate purchased goods; mixed goods or split allocations can support different categories, so choose none when no single category represents the reviewed subject. Truncated evidence is incomplete. Compare the full tree and parent names. The imported bank/CSV Source Category is a clue, not an authoritative household category. Never create or invent categories. Choose none when the roster or evidence does not support a choice. Return a reviewed proposal only; preserve any explicit category until the user applies a change.",
    roster: spendingCategoryRoster,
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: (c) => c.path,
    renderLine: (c) => `${c.id} | ${c.path}`,
    parentIdOf: (c) => c.parentId,
    subject: (basis) => renderSubject(entity, basis),
  };
}

const FIELD_SUGGEST_OVERRIDES = {
  "vendor.defaultSpendingCategoryId": {
    ...spendingCategorySpec("vendor"),
    rules:
      "Suggest an existing spending category suitable as this vendor's fallback from saved principal purchase lines, purchased Products and their category mappings, and independent explicit classifications. Compare the full spending-category tree. Never use the vendor's existing default or classifications inherited from it as evidence. A mixed retailer or sparse, ambiguous history can support no single default: choose none. Preserve explicit decisions until reviewed and applied. Refunds and reimbursements are not additional goods; truncated evidence cannot justify a recommendation.",
  },

  "purchase.spendingCategoryId": spendingCategorySpec("purchase"),
  "expense.spendingCategoryId": spendingCategorySpec("expense"),

  "product.categoryId": {
    kind: "reference",
    entity: "productCategory",
    rules:
      "You are a household-product classifier. Choose the ONE most specific existing classification supported by the product evidence. Compare the complete hierarchy, names, aliases, and descriptions. Choose none when the evidence does not support a classification; never invent a category.",
    // Categories are a taxonomy rather than a household-sized roster. Show
    // every live node; `runAiSelection` uses its overflow path above Jev's
    // choice limit instead of silently dropping broad roots or their leaves.
    //
    // The picker's pinned "Suggested" section (`use-auto-field-suggestion.ts`
    // `seedItems`) reads Jev's `alternatives`, which only the decision-tier
    // path produces — the overflow chat-tier pick (`selection.ts`) always
    // returns `alternatives: []`. Past `JEV_MAX_CANDIDATES` (254) live nodes
    // this roster crosses into overflow and "Suggested" quietly degrades to
    // the single winner. 29 nodes today; revisit if the taxonomy grows.
    maxCandidates: Number.MAX_SAFE_INTEGER,
    roster: async (db, basis) =>
      rankCategoryCandidates(await listProductCategoryTreeOptions(db), basis),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: (c) => productCategoryPath(c),
    renderLine: renderProductCategoryOption,
    subject: (basis) => renderSubject("product", basis),
    parentIdOf: (c) => c.ancestorIds.at(-1) ?? null,
  } satisfies ReferenceSuggestSpec<ProductCategorySuggestionOption>,
  "product.ingredientId": {
    kind: "reference",
    entity: "ingredient",
    rules:
      "You link a stocked product to the generic cooking ingredient it is a package of (for example a branded 2 lb bag of jasmine rice → jasmine rice). Choose the ONE listed ingredient a recipe line would name for this product. Choose none for non-food products (tools, supplies, clothing, household goods) and when no listed ingredient is the same food; never pick a merely related food or invent one.",
    maxCandidates: INGREDIENT_ROSTER_CAP,
    roster: (db, basis) =>
      linkedCandidatesForProduct(db, basis.name ?? null, "ingredient"),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: (c) =>
      `${c.id} | ${c.title}${c.subtitle ? ` — ${c.subtitle}` : ""}`,
    subject: (basis) => renderSubject("product", basis),
  } satisfies ReferenceSuggestSpec<LinkedEntityCandidate>,
  "product.growsPlantId": {
    kind: "reference",
    entity: "plant",
    rules:
      "You link a seed packet, plant start, bulb, tuber, or cutting to the ONE listed Plant it grows. A Plant is a cultivar, or a species when it names no cultivar. Choose the same cultivar when the product names one; choose a species-level Plant only when the product names no cultivar. Choose none for anything that is not grown (tools, soil, food, supplies), when the listed Plant is a different cultivar, or when no listed Plant is the same crop; never pick a merely related plant.",
    maxCandidates: INGREDIENT_ROSTER_CAP,
    roster: (db, basis) =>
      linkedCandidatesForProduct(db, basis.name ?? null, "plant"),
    idOf: (c) => c.id,
    labelOf: (c) => c.title,
    detailOf: (c) => c.subtitle,
    renderLine: (c) =>
      `${c.id} | ${c.title}${c.subtitle ? ` — ${c.subtitle}` : ""}`,
    subject: (basis) => renderSubject("product", basis),
  } satisfies ReferenceSuggestSpec<LinkedEntityCandidate>,
  "product.tags": {
    kind: "prune",
    rules:
      entityFieldModels.product.fields
        .find((field) => field.key === "tags")
        ?.control?.suggest?.rules?.join("\n") ?? "",
    arrayKey: "tags",
    maxJevCandidates: 8,
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
    subject: productTagPruneSubject,
  } satisfies ArrayPruneSuggestSpec,
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
  // No `trade` in this basis: `expense.trade`'s own basis includes
  // `projectId`, so the reverse edge would make the pair cyclic — rejected
  // by the manifest compiler (step 1).
  "expense.projectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given an expense and the household's projects, choose the ONE project it belongs to, or none if it isn't tied to a project.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: expenseProjectRoster,
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderExpenseProjectOption,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies ReferenceSuggestSpec<ExpenseProjectOption>,
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
  "purchase.vendorId": {
    kind: "reference",
    entity: "vendor",
    rules:
      "You are a vendor-matching assistant. Given a purchase's display label, order id, and notes, choose the ONE existing vendor it was bought from, or none if no listed vendor fits.",
    maxCandidates: VENDOR_ROSTER_CAP,
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
    subject: (basis) => renderSubject("purchase", basis),
  } satisfies ReferenceSuggestSpec<{ id: string; name: string }>,
  "purchase.defaultProjectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given a purchase's display label, vendor, and notes, choose the ONE project it belongs to, or none if it isn't tied to a project.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    roster: (db) => projectNameOptions(db),
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: projectOptionDetail,
    renderLine: renderProjectOption,
    subject: (basis) => renderSubject("purchase", basis),
  } satisfies ReferenceSuggestSpec<ProjectOptionsOut>,
} satisfies Record<
  Exclude<GeneratedSuggestFieldKey, EnumSuggestKey | `${string}.emoji`>,
  FieldSuggestSpec
>;

type EnumSuggestKey =
  | "vendor.spendingProfile"
  | "planting.status"
  | "gardenEntry.kind"
  | "location.type"
  | "project.kind"
  | "project.defaultTrade"
  | "meal.mealType"
  | "meal.mealKind"
  | "task.trade"
  | "expense.costType"
  | "expense.lineKind"
  | "expense.trade"
  | "purchase.defaultTrade"
  | "productCategory.feature"
  | "vendor.evidenceExpectation"
  | "purchase.evidenceExpectation"
  | "financialTransaction.evidenceExpectation"
  | "spendingCategory.evidenceExpectation"
  | "spendingCategory.productExpectation";

// oxlint-disable anti-slop/no-known-value-widening -- The closed generated key union is validated by the final registry satisfies check; this builder must return that map after enumerating model fields.
function manifestEnumSpecs(): Record<EnumSuggestKey, FieldSuggestSpec> {
  const specs: Partial<Record<EnumSuggestKey, FieldSuggestSpec>> = {};
  // SAFETY: Object.entries erases generated entity and field unions; each
  // value still comes from the generated field model declared below.
  const models = Object.entries(entityFieldModels) as [
    string,
    {
      fields: readonly {
        key: string;
        control: {
          options:
            | readonly { value: string; label: string; description?: string }[]
            | null;
          suggest: { mode: "fill" | "prune"; rules?: readonly string[] } | null;
        } | null;
      }[];
    },
  ][];
  for (const [entity, model] of models)
    for (const field of model.fields) {
      const options = field.control?.options;
      const suggest = field.control?.suggest;
      if (!options?.length || !suggest || suggest.mode !== "fill") continue;
      // SAFETY: this union enumerates all generated enum suggestion fields.
      const key = `${entity}.${field.key}` as EnumSuggestKey;
      const byValue = new Map<
        string,
        { value: string; label: string; description?: string }
      >(options.map((option) => [option.value, option]));
      const spec: EnumSuggestSpec<string> = {
        kind: "enum",
        values: options
          .filter(
            ({ value }) => !(key === "location.type" && value === "furniture"),
          )
          .map(({ value }) => value),
        describe(value) {
          return byValue.get(value)?.description ?? value;
        },
        labelOf(value) {
          return byValue.get(value)?.label ?? value;
        },
        rules: suggest.rules?.join("\n") ?? "",
        subject: (basis) => renderSubject(entity, basis),
      };
      if (key === "productCategory.feature")
        spec.candidates = async (db, raw) => {
          if (raw.parentId) return [];
          const bound: Set<string> = new Set(
            await listBoundCategoryFeatures(db),
          );
          return options
            .map(({ value }) => value)
            .filter((value) => !bound.has(value));
        };
      specs[key] = spec;
    }
  // SAFETY: every declared EnumSuggestKey was visited above; missing keys fail the merged registry completeness check.
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Runtime enumeration fills precisely the enum keys in this closed generated union.
  const completeSpecs = specs as Record<EnumSuggestKey, FieldSuggestSpec>;
  return completeSpecs;
}

export const FIELD_SUGGEST_REGISTRY = {
  ...manifestEnumSpecs(),
  ...FIELD_SUGGEST_OVERRIDES,
} satisfies Record<
  Exclude<GeneratedSuggestFieldKey, `${string}.emoji`>,
  FieldSuggestSpec
>;

export function fieldSuggestSpecFor(
  entity: string,
  field: string,
): FieldSuggestSpec | undefined {
  if (field === "emoji" && Object.hasOwn(entityFieldModels, entity)) {
    return {
      kind: "enum",
      values: emojiCandidates,
      describe(value) {
        return `A single emoji symbol to help recognize the ${entity} record: ${value}`;
      },
      labelOf: (value) => value,
      rules:
        "Choose one emoji that makes this record easy to recognize from its saved identity and category context. Use none when there is insufficient evidence. This is a reviewed proposal; never change a saved value automatically.",
      subject: (basis) => renderSubject(entity, basis),
    };
  }
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
