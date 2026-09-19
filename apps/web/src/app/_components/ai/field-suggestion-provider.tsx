import type { FieldSuggestion } from "@cubby/schemas/ai";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";
import { useFormContext, useWatch } from "react-hook-form";

import {
  basisValueOf,
  type EntitySuggestionsOperations,
  FIELD_SUGGEST_DEBOUNCE_MS,
  isBasisSufficient,
  suggestTargetsFor,
  useEntitySuggestionsQuery,
} from "./field-suggestion";

export interface FieldSuggestionContextValue {
  readonly entity: ShortcodeEntity;
  readonly mode: "create" | "edit";
  readonly suggestions: Record<string, FieldSuggestion | null>;
  readonly isFetching: boolean;
  /** Records that `field`'s current value is this provider's own write, still
   * untouched — the next basis snapshot sends `null` for it instead of
   * parroting it back (see the module doc comment). */
  markAutoFilled: (field: string, value: string) => void;
  /** Called once the field is dirtied — by a manual edit or `apply()` — so its
   * real value rejoins the basis. */
  clearAutoFilled: (field: string) => void;
  /** Whether `field` currently holds this provider's own untouched write. */
  isAutoFilled: (field: string) => boolean;
}

const FieldSuggestionContext =
  createContext<FieldSuggestionContextValue | null>(null);

/** `null` when no `FieldSuggestionProvider` is mounted — every consumer
 * (`useAutoFieldSuggestion`, `AutoSuggestSlot`) treats that as a no-op, not
 * an error, so a field's suggest wiring works whether or not its surface has
 * opted into the provider yet. */
export function useFieldSuggestionContext(): FieldSuggestionContextValue | null {
  return useContext(FieldSuggestionContext);
}

/**
 * One `ai.suggestFields` request per mounted form, owning the RHF watch →
 * debounce → query pipeline every suggestable field reads from.
 *
 * **Why one request, not one per field**: a per-field query cascades (the
 * expense capture dialog alone would fire ~8 calls per settled name) and
 * cannot express dependency ordering (`expense.trade`'s basis includes
 * `projectId`, itself a target). The server resolves every requested target
 * in one round trip, in dependency order.
 *
 * **Why the client never re-keys on its own writes**: once a target is
 * silently auto-filled, its watched value in the form IS the suggestion —
 * sending that back as basis would have the client parrot its own guess
 * rather than let the server re-derive it fresh (and chain it into
 * dependent targets) on every subsequent keystroke elsewhere in the form.
 * `autoFilledRef` tracks which targets are in that state; `markAutoFilled`/
 * `clearAutoFilled` (called by `useAutoFieldSuggestion`, the field-level half
 * of this system) keep it in sync with each field's real dirty state.
 */
export function FieldSuggestionProvider({
  entity,
  mode,
  paths,
  staticBasis,
  disabled = false,
  operations,
  fieldKeys,
  children,
}: {
  entity: ShortcodeEntity;
  mode: "create" | "edit";
  /** Maps a basis field key to its RHF path, when the form field's path
   * differs from the bare manifest key (e.g. a nested or renamed field). */
  paths?: Readonly<Record<string, string>>;
  /** Basis values that are fixed for this mount rather than read from the
   * form (e.g. `{ productId }` in the add-to-inventory dialog) — these keys
   * are not watched. */
  staticBasis?: Readonly<Record<string, string | null>>;
  disabled?: boolean;
  operations?: EntitySuggestionsOperations;
  /** Restrict targets to this roster of field keys — the mounted intent's
   * field list. Omit to offer every `control.suggest` field the entity's
   * manifest declares, whether or not this form actually renders each one
   * (an unrendered target simply never gets an `AutoSuggestSlot`/hook to read
   * its answer, so it costs nothing beyond one basis key in the request). */
  fieldKeys?: readonly string[];
  children: ReactNode;
}) {
  const form = useFormContext();
  const targets = useMemo(
    () => suggestTargetsFor(entity, fieldKeys),
    [entity, fieldKeys],
  );

  const watchedKeys = useMemo(
    () =>
      targets.basisKeys.filter(
        (key) => !(staticBasis && Object.hasOwn(staticBasis, key)),
      ),
    [targets.basisKeys, staticBasis],
  );
  const watchedPaths = useMemo(
    () => watchedKeys.map((key) => paths?.[key] ?? key),
    [watchedKeys, paths],
  );

  const watchedValues: unknown[] = useWatch({
    control: form.control,
    name: watchedPaths,
  });

  const autoFilledRef = useRef(new Map<string, string>());

  const markAutoFilled = useCallback((field: string, value: string) => {
    autoFilledRef.current.set(field, value);
  }, []);
  const clearAutoFilled = useCallback((field: string) => {
    autoFilledRef.current.delete(field);
  }, []);
  const isAutoFilled = useCallback(
    (field: string) => autoFilledRef.current.has(field),
    [],
  );

  const basis = useMemo(() => {
    const snapshot = { ...staticBasis };
    watchedKeys.forEach((key, index) => {
      snapshot[key] = autoFilledRef.current.has(key)
        ? null
        : basisValueOf(watchedValues[index]);
    });
    return snapshot;
    // `autoFilledRef` is a ref: its mutations don't participate in React's
    // dependency comparison, but every mutation happens synchronously inside
    // an effect that also touches `watchedValues` (the auto-fill write
    // itself), so this recomputes whenever the ref could have changed.
  }, [watchedKeys, watchedValues, staticBasis]);

  const [debouncedBasis] = useDebouncedValue(basis, {
    wait: FIELD_SUGGEST_DEBOUNCE_MS,
  });

  const sufficient = isBasisSufficient(entity, targets, debouncedBasis);
  const source = useMemo(
    () =>
      targets.targets.length > 0 && sufficient
        ? {
            entity,
            targets: targets.targets.map((target) => target.key),
            basis: debouncedBasis,
          }
        : null,
    [entity, targets, sufficient, debouncedBasis],
  );

  const { suggestions, isFetching } = useEntitySuggestionsQuery({
    source,
    enabled: !disabled,
    operations,
  });

  const value = useMemo<FieldSuggestionContextValue>(
    () => ({
      entity,
      mode,
      suggestions,
      isFetching,
      markAutoFilled,
      clearAutoFilled,
      isAutoFilled,
    }),
    [
      entity,
      mode,
      suggestions,
      isFetching,
      markAutoFilled,
      clearAutoFilled,
      isAutoFilled,
    ],
  );

  return (
    <FieldSuggestionContext.Provider value={value}>
      {children}
    </FieldSuggestionContext.Provider>
  );
}
