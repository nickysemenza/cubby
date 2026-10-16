/**
 * The declarative half of each field suggestion: the decision kind, its rules,
 * vocabulary or roster bound, and the subject the model sees. The Decisions
 * catalog and the AI refresh manifest read it without a database;
 * `field-suggest/registry.ts` adds each field's rosters and candidates.
 */
import { emojiCandidates } from "@cubby/schemas/emoji";
import {
  entityFieldModels,
  type EntityFieldModel,
  type GeneratedSuggestFieldKey,
} from "@cubby/schemas/entity-fields";

import type { DecisionChoicePrompt } from "./decision-choice";
import { locationSuggestionSpec } from "./prompts/location-suggest";

/** Reference keys are already replaced by the record's display name. */
export type ResolvedBasis = Readonly<Record<string, string | null>>;
/** The client-supplied basis: reference keys are still shortcodes. */
export type RawBasis = Readonly<Record<string, string | null>>;

/**
 * `V`-typed members use method shorthand on purpose: TypeScript checks a
 * method signature's parameter bivariantly, so a concrete
 * `EnumSuggestDecision<ProductCategory>` stays assignable to the fixed
 * `EnumSuggestDecision<string>` member of `FieldSuggestDecision`.
 */
export interface EnumSuggestDecision<V extends string> {
  kind: "enum";
  allowNone?: boolean;
  values: readonly V[];
  describe(v: V): string;
  labelOf?(v: V): string;
  rules: string;
  subject(basis: ResolvedBasis): string;
}

export interface ReferenceSuggestDecision {
  kind: "reference";
  /** The shortcode entity this reference field points to. */
  entity: string;
  rules: string;
  maxCandidates: number;
  subject(basis: ResolvedBasis): string;
}

export interface TextRosterSuggestDecision {
  kind: "text";
  rules: string;
  maxCandidates: number;
  subject(basis: ResolvedBasis): string;
}

/** A `control.suggest.mode: "prune"` target's per-tag decision. */
export interface ArrayPruneSuggestDecision {
  kind: "prune";
  rules: string;
  /** The target field's own manifest key (e.g. `"tags"`) — where the
   * self-basis JSON array lives in `raw`. */
  arrayKey: string;
  /** Caps the per-survivor decision calls a large ad-hoc tag list could incur. */
  maxDecisionCandidates: number;
  /** One survivor tag's decision subject line. */
  subject(basis: ResolvedBasis, value: string): string;
}

export type FieldSuggestDecision =
  | EnumSuggestDecision<string>
  | ReferenceSuggestDecision
  | TextRosterSuggestDecision
  | ArrayPruneSuggestDecision;

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

/** Rosters bounded well under `DECISION_MAX_CANDIDATES` (254): the decision tier
 * is the common case, and only a very large household ever overflows to the
 * fast-tier selection feature. */
export const REFERENCE_ROSTER_CAP = 200;
/** Vendor names: small enough the decision model sees the whole household roster. */
export const VENDOR_ROSTER_CAP = 200;
/** Semantic neighbours of a product name; the right ingredient is near the top. */
export const INGREDIENT_ROSTER_CAP = 25;

/** `product.tags`'s subject line: the shared product subject plus the one
 * candidate tag under review — `ArrayPruneSuggestSpec.subject` is called once
 * per survivor, not once per request. */
const productTagPruneSubject = (basis: ResolvedBasis, value: string): string =>
  `${renderSubject("product", basis)}\nCandidate tag: "${value}"`;

function spendingCategoryDecision(
  entity: "purchase" | "expense" | "vendor",
): ReferenceSuggestDecision {
  return {
    kind: "reference",
    entity: "spendingCategory",
    maxCandidates: Number.MAX_SAFE_INTEGER,
    rules:
      (entity === "purchase"
        ? "This proposal changes an explicit fallback only; it never classifies all linked Expense lines or replaces mixed line classifications. "
        : "Classify this Expense line only, using its own purpose and Product evidence. Preserve adjustment and reimbursement roles; a transaction link alone supplies no item-dollar attribution. ") +
      "Choose the most specific existing spending category supported by the transaction or purchase evidence. Saved linked evidence preserves signed amounts, principal versus adjustment lines, reimbursement roles and split settlements. When saved purpose or linked spending clearly identifies what a reimbursement repays, choose that original spending category (for example restaurant dinner), without treating the reimbursement as new purchased goods. A payment provider name, credit/debit direction, or income/refund kind alone cannot establish that purpose. Do not count tax, shipping, refunds or reimbursements as separate purchased goods; mixed goods or split allocations can support different categories, so choose none when no single category represents the reviewed subject. Truncated evidence is incomplete. Compare the full tree and parent names. The imported bank/CSV Source Category is a clue, not an authoritative household category. Never create or invent categories. Choose none when the roster or evidence does not support a choice. Return a reviewed proposal only; preserve any explicit category until the user applies a change.",
    subject: (basis) => renderSubject(entity, basis),
  };
}

const FIELD_SUGGEST_DECISION_OVERRIDES = {
  "financialAccount.primaryCardholderId": {
    kind: "reference",
    entity: "ledgerParty",
    maxCandidates: REFERENCE_ROSTER_CAP,
    rules:
      "Choose a primary cardholder only from explicit primary-cardholder or account-holder evidence in saved notes or statement evidence. An authorized user, funding party, purchase frequency, shared funding, an account nickname or inventory ownership never establishes the primary cardholder. Choose none for missing, conflicting or ambiguous evidence. Preserve the saved assignment until explicitly reviewed and applied. Never change Provisional status.",
    subject: (basis) => renderSubject("financialAccount", basis),
  } satisfies ReferenceSuggestDecision,
  "financialAccount.issuer": {
    kind: "text",
    maxCandidates: REFERENCE_ROSTER_CAP,
    rules:
      "Choose the credit-card issuer supported by this account's name, provider identity or explicit statement evidence. A payment network is not an issuer. Saved issuer vocabulary from other accounts is not evidence about this account. Choose none for ambiguous or insufficient evidence. Preserve the saved identity until explicitly reviewed and applied; never change the account kind or Provisional status.",
    subject: (basis) => renderSubject("financialAccount", basis),
  } satisfies TextRosterSuggestDecision,
  "vendor.defaultSpendingCategoryId": {
    ...spendingCategoryDecision("vendor"),
    rules:
      "Suggest an existing spending category suitable as this vendor's fallback from saved principal purchase lines, purchased Products and their category mappings, and independent explicit classifications. Compare the full spending-category tree. Never use the vendor's existing default or classifications inherited from it as evidence. A mixed retailer or sparse, ambiguous history can support no single default: choose none. Preserve explicit decisions until reviewed and applied. Refunds and reimbursements are not additional goods; truncated evidence cannot justify a recommendation.",
  },
  "purchase.spendingCategoryId": spendingCategoryDecision("purchase"),
  "expense.spendingCategoryId": spendingCategoryDecision("expense"),
  "product.categoryId": {
    kind: "reference",
    entity: "productCategory",
    rules:
      "You are a household-product classifier. Choose the ONE most specific existing classification supported by the product evidence. Compare the complete hierarchy, names, aliases, and descriptions. Choose none when the evidence does not support a classification; never invent a category.",
    // Categories are a taxonomy rather than a household-sized roster. Show
    // every live node; `runAiSelection` uses its overflow path above the decision model's
    // choice limit instead of silently dropping broad roots or their leaves.
    //
    // The picker's pinned "Suggested" section (`use-auto-field-suggestion.ts`
    // `seedItems`) reads the decision model's `alternatives`, which only the decision-tier
    // path produces — the overflow chat-tier pick (`selection.ts`) always
    // returns `alternatives: []`. Past `DECISION_MAX_CANDIDATES` (254) live nodes
    // this roster crosses into overflow and "Suggested" quietly degrades to
    // the single winner. 29 nodes today; revisit if the taxonomy grows.
    maxCandidates: Number.MAX_SAFE_INTEGER,
    subject: (basis) => renderSubject("product", basis),
  } satisfies ReferenceSuggestDecision,
  "product.ingredientId": {
    kind: "reference",
    entity: "ingredient",
    rules:
      "You link a stocked product to the generic cooking ingredient it is a package of (for example a branded 2 lb bag of jasmine rice → jasmine rice). Choose the ONE listed ingredient a recipe line would name for this product. Choose none for non-food products (tools, supplies, clothing, household goods) and when no listed ingredient is the same food; never pick a merely related food or invent one.",
    maxCandidates: INGREDIENT_ROSTER_CAP,
    subject: (basis) => renderSubject("product", basis),
  } satisfies ReferenceSuggestDecision,
  "product.growsPlantId": {
    kind: "reference",
    entity: "plant",
    rules:
      "You link a seed packet, plant start, bulb, tuber, or cutting to the ONE listed Plant it grows. A Plant is a cultivar, or a species when it names no cultivar. Choose the same cultivar when the product names one; choose a species-level Plant only when the product names no cultivar. Choose none for anything that is not grown (tools, soil, food, supplies), when the listed Plant is a different cultivar, or when no listed Plant is the same crop; never pick a merely related plant.",
    maxCandidates: INGREDIENT_ROSTER_CAP,
    subject: (basis) => renderSubject("product", basis),
  } satisfies ReferenceSuggestDecision,
  "product.tags": {
    kind: "prune",
    rules:
      entityFieldModels.product.fields
        .find((field) => field.key === "tags")
        ?.control?.suggest?.rules?.join("\n") ?? "",
    arrayKey: "tags",
    maxDecisionCandidates: 8,
    subject: productTagPruneSubject,
  } satisfies ArrayPruneSuggestDecision,
  "inventory.locationId": {
    kind: "reference",
    entity: "location",
    rules: locationSuggestionSpec.rules,
    maxCandidates: REFERENCE_ROSTER_CAP,
    subject: (basis) => renderSubject("inventory", basis),
  } satisfies ReferenceSuggestDecision,
  "task.projectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given a task and the household's projects, choose the ONE project it belongs to, or none if it stands alone.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    subject: (basis) => renderSubject("task", basis),
  } satisfies ReferenceSuggestDecision,
  "task.subjectProductId": {
    kind: "reference",
    entity: "product",
    rules:
      "You are a product-linking assistant. Given a task's name, choose the ONE product it is about, or none if it isn't about a specific product.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    subject: (basis) => renderSubject("task", basis),
  } satisfies ReferenceSuggestDecision,
  // No `trade` in this basis: `expense.trade`'s own basis includes
  // `projectId`, so the reverse edge would make the pair cyclic — rejected
  // by the manifest compiler (step 1).
  "expense.projectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given an expense and the household's projects, choose the ONE project it belongs to, or none if it isn't tied to a project.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies ReferenceSuggestDecision,
  "expense.productId": {
    kind: "reference",
    entity: "product",
    rules:
      "You are a product-linking assistant. Given an expense's name, choose the ONE product it is for, or none if it isn't about a specific product.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies ReferenceSuggestDecision,
  "expense.vendor": {
    kind: "text",
    rules:
      "You are a vendor-matching assistant. Given an expense's name, notes, and order id, choose the ONE existing vendor it was bought from, or none if no listed vendor fits.",
    maxCandidates: VENDOR_ROSTER_CAP,
    subject: (basis) => renderSubject("expense", basis),
  } satisfies TextRosterSuggestDecision,
  "purchase.vendorId": {
    kind: "reference",
    entity: "vendor",
    rules:
      "You are a vendor-matching assistant. Given a purchase's display label, order id, and notes, choose the ONE existing vendor it was bought from, or none if no listed vendor fits.",
    maxCandidates: VENDOR_ROSTER_CAP,
    subject: (basis) => renderSubject("purchase", basis),
  } satisfies ReferenceSuggestDecision,
  "purchase.defaultProjectId": {
    kind: "reference",
    entity: "project",
    rules:
      "You are a project-linking assistant. Given a purchase's display label, vendor, and notes, choose the ONE project it belongs to, or none if it isn't tied to a project.",
    maxCandidates: REFERENCE_ROSTER_CAP,
    subject: (basis) => renderSubject("purchase", basis),
  } satisfies ReferenceSuggestDecision,
} satisfies Record<
  Exclude<GeneratedSuggestFieldKey, EnumSuggestKey | `${string}.emoji`>,
  FieldSuggestDecision
>;

export type EnumSuggestKey =
  | "financialAccount.network"
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
  | "vendor.itemizationExpectation"
  | "purchase.itemizationExpectation"
  | "financialTransaction.itemizationExpectation"
  | "spendingCategory.itemizationExpectation"
  | "spendingCategory.productExpectation";

// oxlint-disable anti-slop/no-known-value-widening -- The closed generated key union is validated by the final registry satisfies check; this builder must return that map after enumerating model fields.
function manifestEnumDecisions(): Record<
  EnumSuggestKey,
  EnumSuggestDecision<string>
> {
  const specs: Partial<Record<EnumSuggestKey, EnumSuggestDecision<string>>> =
    {};
  // SAFETY: Object.entries erases generated entity and field unions; each
  // value still comes from the generated field model declared below.
  const models = Object.entries(entityFieldModels) as [
    string,
    Pick<EntityFieldModel, "fields">,
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
      specs[key] = {
        kind: "enum",
        allowNone: suggest.allowNone,
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
    }
  // SAFETY: every declared EnumSuggestKey was visited above; missing keys fail the merged registry completeness check.
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Runtime enumeration fills precisely the enum keys in this closed generated union.
  const completeSpecs = specs as Record<
    EnumSuggestKey,
    EnumSuggestDecision<string>
  >;
  return completeSpecs;
}

export const FIELD_SUGGEST_DECISIONS = {
  ...manifestEnumDecisions(),
  ...FIELD_SUGGEST_DECISION_OVERRIDES,
} satisfies Record<
  Exclude<GeneratedSuggestFieldKey, `${string}.emoji`>,
  FieldSuggestDecision
>;

/** Every entity's `emoji` field shares one enum decision over the emoji set. */
export function emojiDecision(entity: string): EnumSuggestDecision<string> {
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

export function fieldSuggestDecisionFor(
  entity: string,
  field: string,
): FieldSuggestDecision | undefined {
  if (field === "emoji" && Object.hasOwn(entityFieldModels, entity))
    return emojiDecision(entity);
  const key = `${entity}.${field}`;
  if (!Object.hasOwn(FIELD_SUGGEST_DECISIONS, key)) return undefined;
  // SAFETY: Object.hasOwn above proves this dynamic key belongs to the
  // table, while TypeScript retains only its full literal union.
  return FIELD_SUGGEST_DECISIONS[key as keyof typeof FIELD_SUGGEST_DECISIONS];
}

/** `runDecisionChoice`'s two per-tag criteria: index 0 is "redundant", index 1 is
 * "genuine". A removal only ever acts on index 0; the `evaluated/none`
 * outcome (every entry survived) also reports index 1, the probability the
 * survivor is genuinely worth keeping. */
const TAG_PRUNE_CHOICES = [
  "Restates the manufacturer, the classification, or a generic category word already recorded elsewhere on the product.",
  "A genuine compatibility or ecosystem token (a battery platform, mount, thread, or size standard) worth keeping.",
] as const;
/** One survivor tag's binary judgment; the Decisions catalog renders it. */
export function prunePrompt(
  spec: ArrayPruneSuggestDecision,
  basis: ResolvedBasis,
  value: string,
): DecisionChoicePrompt {
  return {
    subject: spec.subject(basis, value),
    rules: spec.rules,
    choices: [...TAG_PRUNE_CHOICES],
    allowNone: false,
  };
}
