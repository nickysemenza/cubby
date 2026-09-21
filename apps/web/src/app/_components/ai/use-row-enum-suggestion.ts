import type { FieldSuggestion } from "@cubby/schemas/ai";
import { useDebouncedValue } from "@tanstack/react-pacer";
import type { UseQueryOptions } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
  useFormState,
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import { FIELD_SUGGEST_DEBOUNCE_MS } from "./field-suggestion";

/** A row field's raw current value, parsed to text — `""` (not `null`) for
 * anything else, so it compares directly against `unsetValues`. */
const textValueSchema = z.string().catch("");

/** Silent auto-apply is a higher bar than the hint's own review gate
 * (`actionableSuggestion`'s 0.85/0.95 split, `suggestion-review.tsx`) — a
 * row commits itself with no operator glance at all, so it only does that
 * once Jev is very sure. */
const AUTO_APPLY_THRESHOLD = 0.95;

export interface UseRowEnumSuggestionResult {
  suggestion: FieldSuggestion | null;
  isPending: boolean;
  /** The row's current value already equals the suggestion. */
  applied: boolean;
  /** Writes the suggestion, dirtying and touching the field — for the
   * `FieldSuggestionHint` "Use suggestion" action once auto-apply declines
   * (the row was touched, or the answer fell under the threshold). */
  apply: () => void;
}

/**
 * The generic "ask about one enum cell inside an array-editor row" pipeline
 * behind `ExternalIdKindSuggestion` — and, per its own module doc, any
 * future per-row enum a bulk editor grows. Distinct from
 * `useAutoFieldSuggestion` (`FieldSuggestionProvider`'s per-form batch
 * pipeline): a row has no entity-wide provider to share, so this hook owns
 * its own debounce → query → auto-apply loop directly against one
 * `ai.*.queryOptions` factory.
 */
export function useRowEnumSuggestion<
  TFieldValues extends FieldValues,
  TBasis,
  // Inferred from `queryOptions`'s actual return type (the operation
  // catalog brands each descriptor's query key on its input shape) rather
  // than fixed to `readonly unknown[]` here, which `useQuery` rejects as an
  // unrelated, wider key type.
  TQueryKey extends readonly unknown[],
>({
  queryOptions,
  basis,
  enabled = true,
  form,
  path,
  unsetValues,
}: {
  /** Builds this row's query options from the (debounced) basis — typically
   * `ai.<operation>.queryOptions(basis)`. */
  queryOptions: (
    basis: TBasis,
  ) => UseQueryOptions<
    FieldSuggestion | null,
    Error,
    FieldSuggestion | null,
    TQueryKey
  >;
  basis: TBasis;
  enabled?: boolean;
  form: UseFormReturn<TFieldValues>;
  path: Path<TFieldValues>;
  /** Row values that count as "not yet picked" — auto-apply only ever
   * overwrites one of these, never a value the operator (or an earlier
   * suggestion) actually set. */
  unsetValues: readonly string[];
}): UseRowEnumSuggestionResult {
  const [debouncedBasis] = useDebouncedValue(basis, {
    wait: FIELD_SUGGEST_DEBOUNCE_MS,
  });
  const settled = JSON.stringify(basis) === JSON.stringify(debouncedBasis);
  const opts = queryOptions(debouncedBasis);
  const query = useQuery({
    ...opts,
    enabled: enabled && settled,
    retry: false,
    meta: { ...opts.meta, silentErrors: true },
  });
  const suggestion = settled ? (query.data ?? null) : null;

  const formState = useFormState({ control: form.control, name: path });
  const fieldState = form.getFieldState(path, formState);
  const isDirty = fieldState.isDirty || fieldState.isTouched;
  const current: unknown = form.getValues(path);
  const currentText = textValueSchema.parse(current);
  const isUnset = unsetValues.includes(currentText);
  const applied = suggestion?.value != null && currentText === suggestion.value;

  useEffect(() => {
    if (
      !enabled ||
      isDirty ||
      !isUnset ||
      !suggestion?.value ||
      suggestion.probability == null ||
      suggestion.probability < AUTO_APPLY_THRESHOLD ||
      applied
    ) {
      return;
    }
    // SAFETY: `path` names a row's enum cell (caller-declared, e.g.
    // `externalIdPaths.kind`); `suggestion.value` is one of that same enum's
    // own members, so it is a valid value at that path even though the
    // generic form type can't express the relationship here.
    form.setValue(
      path,
      suggestion.value as PathValue<TFieldValues, Path<TFieldValues>>,
    );
  }, [enabled, isDirty, isUnset, suggestion, applied, form, path]);

  const apply = useCallback(() => {
    if (!suggestion?.value) return;
    // SAFETY: same relationship as the auto-apply effect above.
    form.setValue(
      path,
      suggestion.value as PathValue<TFieldValues, Path<TFieldValues>>,
      { shouldDirty: true, shouldTouch: true },
    );
  }, [suggestion, form, path]);

  return {
    suggestion,
    isPending: query.isFetching,
    applied,
    apply,
  };
}
