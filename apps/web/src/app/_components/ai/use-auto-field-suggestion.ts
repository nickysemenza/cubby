import type { FieldSuggestion } from "@cubby/schemas/ai";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { useCallback, useEffect } from "react";
import {
  type FieldValues,
  type Path,
  type PathValue,
  useFormState,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { enumFieldLabel } from "~/entities/enum-field-display";

import { basisValueOf } from "./field-suggestion";
import { useFieldSuggestionContext } from "./field-suggestion-provider";

export interface UseAutoFieldSuggestionResult {
  currentLabel: string | null;
  currentValue: string | null;
  questionKey: string;
  suggestion: FieldSuggestion | null;
  /** The field's current value already equals the suggestion (auto-filled or
   * manually picked the same thing). */
  applied: boolean;
  isPending: boolean;
  /** Writes the suggestion, dirtying and touching the field — for hint
   * surfaces (edit mode, or once a manual edit has cleared the auto-fill). */
  apply: () => void;
  /** The suggestion rendered as a `ComboboxItem`, for a reference-valued
   * field whose picker needs a label for an id it just silently wrote (the
   * id alone would otherwise render as a bare shortcode). */
  seedItem: ComboboxItem | null;
  /** The winner plus every alternative, each carrying a pinned "Suggested"
   * `presentation.group` (order -1, ahead of every other group) and a
   * rounded-percent `status` — a picker merges these ahead of its own
   * roster so a `suggestField` reference picker always shows Jev's ranking,
   * not just the single value it silently wrote. Empty with no suggestion. */
  seedItems: readonly ComboboxItem[];
}

/** Stable empty array — `NO_SUGGESTION`'s `seedItems` and the no-suggestion
 * path below must never allocate a fresh `[]` per render (web-runtime
 * hook-default rule). */
const EMPTY_SEED_ITEMS: readonly ComboboxItem[] = [];

const NO_SUGGESTION: UseAutoFieldSuggestionResult = {
  currentLabel: null,
  currentValue: null,
  questionKey: "",
  suggestion: null,
  applied: false,
  isPending: false,
  apply: () => {},
  seedItem: null,
  seedItems: EMPTY_SEED_ITEMS,
};

/** "Suggested" pins ahead of every other picker group (`order: -1`, below
 * every real group's `order >= 0`). */
const SUGGESTED_GROUP = { id: "suggested", label: "Suggested", order: -1 };

const suggestedStatus = (probability: number | null) =>
  probability == null
    ? undefined
    : { label: `${Math.round(probability * 100)}%` };

/** What a suggestion writes into a form field: a raw id for `valueKind:"id"`,
 * a full picker item for `"item"`. */
type SuggestionWriteValue = string | ComboboxItem | null;

const comboboxItemIdSchema = z.object({ id: z.string() });

function explicitModeField(entity: string | undefined, field: string) {
  if (entity !== "task") return null;
  if (field === "projectId") return "projectMode";
  if (field === "subjectProductId") return "subjectProductMode";
  return null;
}

function suggestionSeedItem(suggestion: FieldSuggestion): ComboboxItem | null {
  if (!suggestion.value) return null;
  return {
    id: suggestion.value,
    shortcode: suggestion.value,
    name: suggestion.label ?? suggestion.value,
    detail: suggestion.detail ?? undefined,
  };
}

/** The winner plus every alternative, in Jev's ranked order, each pinned
 * into the "Suggested" group. `[]` when there is no winner to seed from —
 * `alternatives` alone (a stale winner, an unresolved target) is never
 * seeded on its own. */
function suggestionSeedItems(suggestion: FieldSuggestion): ComboboxItem[] {
  const winner = suggestionSeedItem(suggestion);
  if (!winner) return [];
  return [
    {
      ...winner,
      presentation: {
        group: SUGGESTED_GROUP,
        status: suggestedStatus(suggestion.probability),
      },
    },
    ...suggestion.alternatives.map((alternative): ComboboxItem => ({
      id: alternative.value,
      shortcode: alternative.value,
      name: alternative.label,
      detail: alternative.detail ?? undefined,
      presentation: {
        group: SUGGESTED_GROUP,
        status: suggestedStatus(alternative.probability),
      },
    })),
  ];
}

function suggestionValueFor(
  suggestion: FieldSuggestion,
  valueKind: "id" | "item",
): SuggestionWriteValue {
  return valueKind === "item"
    ? suggestionSeedItem(suggestion)
    : suggestion.value;
}

/** Compares a field's raw current value (untyped — `name` is a generic RHF
 * `Path`, so the caller's concrete field type isn't visible here) against the
 * suggestion, narrowing through zod rather than a hand-rolled `typeof`/`in`
 * check. */
function currentEquals(
  current: unknown,
  suggestion: FieldSuggestion,
  valueKind: "id" | "item",
): boolean {
  if (!suggestion.value) return false;
  if (valueKind === "item") {
    const item = comboboxItemIdSchema.safeParse(current);
    return item.success && item.data.id === suggestion.value;
  }
  const text = z.string().safeParse(current);
  return text.success && text.data === suggestion.value;
}

/**
 * Per-field half of the auto-suggest system. Reads the mounted
 * `FieldSuggestionProvider`'s answer for `field` (a manifest target key, e.g.
 * `"trade"` — distinct from `name`, the RHF path, which can differ under
 * `paths` remapping), silently fills it in while the field is untouched in
 * create mode, and exposes an explicit `apply()` for hint surfaces.
 *
 * Without a mounted provider this is a no-op: every field is `null`/`false`,
 * so a component can call this hook unconditionally regardless of whether its
 * surface has opted into suggestions.
 *
 * **Why not `useAiProposal`**: that hook ties a proposal to a `basisKey`
 * snapshot taken at request time and requires a human to trigger `request()`
 * — it's built for the button-driven USDA/description surfaces, where a
 * person decides when to ask. Here the query key IS the basis
 * (`useEntitySuggestionsQuery`), so staleness is structural: a response can
 * never be shown against a basis it wasn't asked about, and there's no
 * separate "is this still the question I asked" check to reproduce.
 *
 */
export function useAutoFieldSuggestion<TFieldValues extends FieldValues>({
  form,
  name,
  field,
  disabled = false,
  valueKind = "id",
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  field: string;
  disabled?: boolean;
  valueKind?: "id" | "item";
}): UseAutoFieldSuggestionResult {
  const context = useFieldSuggestionContext();
  // Subscribed only so this re-renders when dirtiness changes — `setValue`
  // without options never touches `dirtyFields`, so the silent auto-fill
  // below cannot itself trigger this subscription; the visible value change
  // it causes reaches this component through the caller's own Controller
  // instead (every primitive in step 3 renders its suggest slot inside that
  // Controller's `render` prop).
  const formState = useFormState({ control: form.control, name });
  const state = form.getFieldState(name, formState);
  const isDirty = state.isDirty || state.isTouched;
  const suggestion = context?.suggestions[field] ?? null;
  const resolution = context?.resolutionFor(field) ?? null;
  const current: unknown = form.getValues(name);
  const applied = suggestion
    ? currentEquals(current, suggestion, valueKind)
    : false;

  useEffect(() => {
    if (
      !context ||
      disabled ||
      context.mode !== "create" ||
      isDirty ||
      context.isFetching ||
      (resolution !== null &&
        !(resolution.mode === "inherit" && resolution.value === null)) ||
      !suggestion?.value ||
      suggestion.probability == null ||
      suggestion.probability < 0.85 ||
      applied
    ) {
      return;
    }
    // SAFETY: `name` is a caller-owned `Path<TFieldValues>`; `valueKind`
    // (set by the same caller) declares that this path holds either the raw
    // id string or a `ComboboxItem` — a relationship the generic form type
    // can't express here.
    form.setValue(
      name,
      suggestionValueFor(suggestion, valueKind) as PathValue<
        TFieldValues,
        Path<TFieldValues>
      >,
    );
    const modeField = explicitModeField(context.entity, field);
    if (modeField) {
      // SAFETY: explicitModeField returns only generated Task mode paths, and
      // both accept the literal `explicit` in the mounted Task form.
      form.setValue(
        modeField as Path<TFieldValues>,
        "explicit" as PathValue<TFieldValues, Path<TFieldValues>>,
      );
    }
    context.markAutoFilled(field, suggestion.value);
  }, [
    context,
    disabled,
    isDirty,
    suggestion,
    applied,
    form,
    name,
    field,
    valueKind,
    resolution,
  ]);

  useEffect(() => {
    if (isDirty) context?.clearAutoFilled(field);
  }, [isDirty, context, field]);

  // Retract a stale auto-fill: the value this hook wrote was the answer to an
  // earlier basis, and the settled query for the current basis has no
  // suggestion for this field (the model declined, or the basis fell below
  // the threshold). Left in place it would read as a live pick with no hint
  // explaining it. `resetField` restores the field's own default without
  // dirtying it, so the field stays eligible for the next suggestion.
  useEffect(() => {
    if (
      !context ||
      disabled ||
      context.mode !== "create" ||
      isDirty ||
      context.isFetching ||
      suggestion?.value ||
      !context.isAutoFilled(field)
    ) {
      return;
    }
    form.resetField(name);
    const modeField = explicitModeField(context.entity, field);
    if (modeField) {
      // SAFETY: explicitModeField returns only generated Task mode paths.
      form.setValue(
        modeField as Path<TFieldValues>,
        "inherit" as PathValue<TFieldValues, Path<TFieldValues>>,
      );
    }
    context.clearAutoFilled(field);
  }, [context, disabled, isDirty, suggestion, form, name, field]);

  const apply = useCallback(() => {
    if (
      !suggestion?.value ||
      context?.isFetching ||
      basisValueOf(form.getValues(name)) !== basisValueOf(current)
    )
      return;
    // SAFETY: see the auto-fill effect above — same caller-declared
    // `valueKind` relationship.
    form.setValue(
      name,
      suggestionValueFor(suggestion, valueKind) as PathValue<
        TFieldValues,
        Path<TFieldValues>
      >,
      { shouldDirty: true, shouldTouch: true },
    );
    const modeField = explicitModeField(context?.entity, field);
    if (modeField) {
      // SAFETY: the only two modeField literals name Task form fields whose
      // generated input contract accepts the literal "explicit".
      form.setValue(
        modeField as Path<TFieldValues>,
        "explicit" as PathValue<TFieldValues, Path<TFieldValues>>,
        { shouldDirty: true },
      );
    }
  }, [suggestion, valueKind, form, name, context, current, field]);

  if (!context) {
    // A `suggestField` control rendered outside a mounted
    // `FieldSuggestionProvider` used to fail silently here (every suggestion
    // is simply absent), which is exactly why the Discard dialogs' missing
    // provider went unnoticed for as long as it did. Loud in dev only — a
    // caller that intentionally has no provider yet passes `disabled`.
    if (import.meta.env.DEV && !disabled) {
      console.error(
        `useAutoFieldSuggestion: field "${field}" has no FieldSuggestionProvider mounted above it. Wrap the form in one, or pass disabled to suppress this.`,
      );
    }
    return NO_SUGGESTION;
  }

  return {
    currentLabel:
      (entityFieldModels[context.entity].fields.find(
        (candidate) => candidate.key === field,
      )?.kind === "enum"
        ? enumFieldLabel(context.entity, field, basisValueOf(current))
        : null) ??
      z.object({ name: z.string() }).safeParse(current).data?.name ??
      basisValueOf(current),
    currentValue: basisValueOf(current),
    questionKey: context.questionKey,
    suggestion,
    applied,
    isPending: context.isFetching,
    apply,
    seedItem: suggestion ? suggestionSeedItem(suggestion) : null,
    seedItems: suggestion ? suggestionSeedItems(suggestion) : EMPTY_SEED_ITEMS,
  };
}
