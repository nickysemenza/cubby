import type { FieldSuggestion } from "@cubby/schemas/ai";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { readReferenceField } from "~/entities/entity-references";
import { ai } from "~/lib/ai.functions";

/**
 * User's call, snappy by design: every typing pause longer than this fires
 * one `ai.suggestFields` request. Jev is the cheap decision tier and the
 * 30-day gateway cache makes repeated prefixes free, so a 20-character name
 * settling in is on the order of 5–15 requests, not one per keystroke.
 * Review `/ai-usage` after a week of real use and raise it (250ms) if the
 * spend is noticeable — this is the one place to change it.
 */
export const FIELD_SUGGEST_DEBOUNCE_MS = 100;

type ManifestField =
  (typeof entityFieldModels)[ShortcodeEntity]["fields"][number];

/** A manifest field whose `control.suggest` opts it into auto-suggestion. */
interface SuggestTarget {
  readonly key: string;
  readonly label: string;
  readonly reference: ManifestField["reference"];
  /** The model fields (of the same entity) whose values feed this target. */
  readonly basis: readonly string[];
  /** `"fill"` proposes a value; `"prune"` (text-array only) proposes
   * removing entries that restate a `basis` field. */
  readonly mode: "fill" | "prune";
}

export interface SuggestTargets {
  readonly targets: readonly SuggestTarget[];
  /** Union of every target's `basis`, deduped — what the caller must watch. */
  readonly basisKeys: readonly string[];
}

const INHERITANCE_CONTEXT_KEYS = {
  expense: ["lineKind", "purchaseId", "productId", "projectId", "trade"],
  task: [
    "parentTaskId",
    "projectId",
    "projectMode",
    "subjectProductId",
    "subjectProductMode",
    "trade",
  ],
} as const satisfies Partial<Record<ShortcodeEntity, readonly string[]>>;

/** Declared suggestion dependencies plus the raw assignment/source keys the
 * authoritative inheritance resolver needs for this entity. */
export function suggestionContextKeys(
  entity: ShortcodeEntity,
  targets: SuggestTargets,
): readonly string[] {
  const inheritedKeys: readonly string[] =
    entity === "expense"
      ? INHERITANCE_CONTEXT_KEYS.expense
      : entity === "task"
        ? INHERITANCE_CONTEXT_KEYS.task
        : [];
  return [...new Set([...targets.basisKeys, ...inheritedKeys])];
}

const EMPTY_TARGETS: SuggestTargets = { targets: [], basisKeys: [] };

/**
 * Every `control.suggest` field of `entity`, optionally restricted to a
 * roster of field keys (e.g. the mounted intent's field list — a form that
 * only renders a subset of the entity's fields has no business asking Jev to
 * fill in ones it never shows), plus the deduped union of their basis keys —
 * what a caller (the provider, or a single-field surface) needs to watch.
 */
export function suggestTargetsFor(
  entity: ShortcodeEntity,
  fieldKeys?: readonly string[],
): SuggestTargets {
  const fields = entityFieldModels[entity].fields;
  const roster = fieldKeys ? new Set(fieldKeys) : null;
  const targets: SuggestTarget[] = [];
  const basisKeys = new Set<string>();
  for (const field of fields) {
    const suggest = field.control?.suggest;
    if (!suggest) continue;
    if (roster && !roster.has(field.key)) continue;
    targets.push({
      key: field.key,
      label: field.label,
      reference: field.reference,
      basis: suggest.basis,
      mode: suggest.mode,
    });
    for (const basisKey of suggest.basis) basisKeys.add(basisKey);
    // A prune target judges its own current entries, so it is an implicit
    // self-basis (the manifest compiler rejects naming it explicitly) — add
    // it here so every caller that watches `basisKeys` (the provider, a
    // record's basis snapshot) ships the target's current value too.
    if (suggest.mode === "prune") basisKeys.add(field.key);
  }
  if (targets.length === 0) return EMPTY_TARGETS;
  return { targets, basisKeys: [...basisKeys] };
}

function fieldByKey(
  entity: ShortcodeEntity,
  key: string,
): ManifestField | undefined {
  return entityFieldModels[entity].fields.find((field) => field.key === key);
}

const basisIdSchema = z.object({ id: z.string() });
const basisArraySchema = z.array(z.string());

/**
 * A basis value in the shape `ai.suggestFields` wants: a trimmed string, an
 * id pulled off a picker's `{ id }` value (`ComboboxItem`-shaped or a raw
 * `{id}`), a JSON-encoded array (a text-array field's current entries — a
 * prune target's own self-basis, or a sibling array field like `aliases`),
 * or `null` when the value carries nothing usable.
 */
export function basisValueOf(value: unknown): string | null {
  const text = z.string().safeParse(value);
  if (text.success) {
    const trimmed = text.data.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const withId = basisIdSchema.safeParse(value);
  if (withId.success) {
    const trimmed = withId.data.id.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const array = basisArraySchema.safeParse(value);
  if (array.success) return JSON.stringify(array.data);
  return null;
}

/**
 * `targets.basisKeys` read off a full entity record via each field's
 * `readKey` — the non-RHF counterpart of the provider's `useWatch` snapshot,
 * for surfaces that hold a whole record rather than a live form (detail-page
 * inline editors, table cells, bulk edit's single-row basis).
 */
export function fieldSuggestionBasisFromRecord<TRecord extends object>(
  entity: ShortcodeEntity,
  targets: SuggestTargets,
  record: TRecord,
) {
  const basis: Record<string, string | null> = {};
  const referenceLabels: Record<string, { id: string; name: string | null }> =
    {};
  for (const key of targets.basisKeys) {
    const readKey = fieldByKey(entity, key)?.readKey ?? key;
    const field = fieldByKey(entity, key);
    // SAFETY: `readKey` comes from the generated field model, which owns
    // this record's shape; a key absent from a partial record just reads
    // `undefined`, which `basisValueOf` treats as null.
    const value = record[readKey as keyof TRecord];
    const reference = field?.reference
      ? readReferenceField(record, field)?.items[0]
      : undefined;
    basis[key] = field?.reference
      ? (reference?.id ?? null)
      : basisValueOf(value);
    if (reference) {
      referenceLabels[key] = { id: reference.id, name: reference.name };
    }
  }
  if (Object.keys(referenceLabels).length > 0) {
    basis.__referenceLabels = JSON.stringify(referenceLabels);
  }
  return basis;
}

/**
 * Whether a basis snapshot is worth asking Jev about at all — guards the
 * cheap-but-not-free decision tier from firing on "a" or an empty picker.
 * Any reference-typed basis key that is set (a picked project, a picked
 * product) is sufficient on its own; otherwise any text basis of at least 2
 * characters is — 3 when every target in this request is a product
 * reference (`task.subjectProductId`, `expense.productId`), where the lexical
 * candidate search itself only kicks in at 3. One rule, kept here so the
 * client and the two product-reference targets can't drift apart.
 */
export function isBasisSufficient(
  entity: ShortcodeEntity,
  targets: SuggestTargets,
  basis: Record<string, string | null>,
): boolean {
  if (targets.targets.length === 0) return false;
  const onlyProductReferenceTargets = targets.targets.every(
    (target) => target.reference?.entity === "product",
  );
  const minTextLength = onlyProductReferenceTargets ? 3 : 2;
  for (const key of targets.basisKeys) {
    const value = basis[key];
    if (!value) continue;
    const field = fieldByKey(entity, key);
    if (field?.reference) return true;
    if (value.length >= minTextLength) return true;
  }
  return false;
}

export interface FieldSuggestionSource {
  basisMode: "provided" | "suggested";
  readonly entity: ShortcodeEntity;
  /** Bare manifest field keys of `entity` being requested this call. */
  readonly targets: readonly string[];
  readonly basis: Record<string, string | null>;
}

/** Transport-injection seam, mirroring `LocationFieldWithAIOperations` and
 * the other existing AI adapters — a test swaps `ai.suggestFields` for a fake
 * via `.withTransport(...)` without touching the hook itself. */
export interface EntitySuggestionsOperations {
  suggestFields: typeof ai.suggestFields;
}

export const productionEntitySuggestionsOperations: EntitySuggestionsOperations =
  {
    suggestFields: ai.suggestFields,
  };

/** Never a fresh `{}` — a stable default keeps `suggestions` referentially
 * equal across renders when there is nothing to show (web-ui hook-default rule). */
const EMPTY_SUGGESTIONS: Record<string, FieldSuggestion | null> = {};
const EMPTY_FIELD_RESOLUTIONS = {};

/** A schema-valid placeholder input used only while `source` is null, so
 * `queryOptions()` (which parses its input unconditionally, even while the
 * query is disabled) never sees an invalid shape. Never fetched: `enabled`
 * gates on `source`, not on this target existing in any registry. */
const INACTIVE_SUGGESTION_SOURCE: FieldSuggestionSource = {
  basisMode: "provided",
  entity: "product",
  targets: ["__inactive__"],
  basis: {},
};

/**
 * The one `ai.suggestFields` query behind every suggestion surface —
 * `FieldSuggestionProvider` (one per form) and `FieldSuggestionApply`
 * (non-RHF surfaces) both call this rather than rolling their own `useQuery`.
 * The query key **is** the basis, so a response can never be shown against a
 * basis it wasn't asked about — no separate staleness check is needed.
 */
export function useEntitySuggestionsQuery({
  source,
  enabled = true,
  operations = productionEntitySuggestionsOperations,
}: {
  source: FieldSuggestionSource | null;
  enabled?: boolean;
  operations?: EntitySuggestionsOperations;
}) {
  const effective = source ?? INACTIVE_SUGGESTION_SOURCE;
  const opts = operations.suggestFields.queryOptions({
    basisMode: effective.basisMode,
    entity: effective.entity,
    targets: [...effective.targets],
    basis: effective.basis,
  });
  const query = useQuery({
    ...opts,
    enabled: enabled && source != null,
    retry: false,
    meta: { ...opts.meta, silentErrors: true },
  });
  return {
    suggestions: query.data?.suggestions ?? EMPTY_SUGGESTIONS,
    fieldResolutions: query.data?.fieldResolutions ?? EMPTY_FIELD_RESOLUTIONS,
    eligibleTargets: query.data?.eligibleTargets ?? [],
    isFetching: query.isFetching,
  };
}
