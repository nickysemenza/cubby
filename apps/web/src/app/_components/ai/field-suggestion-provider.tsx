import type { FieldSuggestion } from "@cubby/schemas/ai";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  fieldResolutionsSchema,
  type FieldResolution,
  type FieldResolutions,
} from "@cubby/schemas/field-resolution";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFormContext, useFormState, useWatch } from "react-hook-form";
import { z } from "zod";

import { Description } from "~/components/ui/description";

import {
  basisValueOf,
  type EntitySuggestionsOperations,
  type FieldSuggestionSource,
  FIELD_SUGGEST_DEBOUNCE_MS,
  isBasisSufficient,
  suggestionContextKeys,
  suggestTargetsFor,
  useEntitySuggestionsQuery,
} from "./field-suggestion";
import { SuggestionVisitProvider } from "./suggestion-review";

export interface FieldSuggestionContextValue {
  readonly questionKey: string;
  readonly entity: ShortcodeEntity;
  readonly mode: "create" | "edit";
  readonly suggestions: Record<string, FieldSuggestion | null>;
  readonly isFetching: boolean;
  readonly resolutionFor: (field: string) => FieldResolution | null;
  readonly isAlternative: (field: string) => boolean;
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
const resolutionRecordSchema = z.looseObject({
  fieldResolutions: fieldResolutionsSchema.optional(),
});

function resolutionModeField(entity: ShortcodeEntity, field: string) {
  if (entity === "task" && field === "projectId") return "projectMode";
  if (entity === "task" && field === "subjectProductId")
    return "subjectProductMode";
  if (entity === "project" && field === "locations") return "locationsMode";
  return null;
}

function isAllocatedExpenseProject(
  entity: ShortcodeEntity,
  field: string,
  basis: FieldSuggestionSource["basis"],
) {
  return (
    entity === "expense" &&
    field === "projectId" &&
    resolveExpenseLineKind(basis) !== "principal"
  );
}

function isUntouchedUnresolved(args: {
  mode: "create" | "edit";
  entity: ShortcodeEntity;
  field: string;
  value: string | null;
  manuallyChanged: boolean;
  autoFilled: boolean;
  resolution: FieldResolution | undefined;
  basis: FieldSuggestionSource["basis"];
}) {
  const explicitNone =
    args.mode === "create" &&
    args.value === null &&
    args.entity === "task" &&
    ((args.field === "projectId" && args.basis.projectMode === "explicit") ||
      (args.field === "subjectProductId" &&
        args.basis.subjectProductMode === "explicit"));
  return (
    args.mode === "create" &&
    !args.manuallyChanged &&
    !explicitNone &&
    (args.value === null || args.autoFilled) &&
    (args.resolution === undefined ||
      (args.resolution.mode === "inherit" && args.resolution.value === null))
  );
}

/** `null` when no `FieldSuggestionProvider` is mounted — every consumer
 * (`useAutoFieldSuggestion`, `AutoSuggestSlot`) treats that as a no-op, not
 * an error, so a field's suggest wiring works whether or not its surface has
 * opted into the provider yet. */
export function useFieldSuggestionContext(): FieldSuggestionContextValue | null {
  return useContext(FieldSuggestionContext);
}

/**
 * One suggestion pipeline per mounted form, owning the RHF watch → debounce →
 * query pipeline every suggestable field reads from. It can issue two batches:
 * untouched empty create targets use `suggested`, while populated targets ask
 * for `provided` alternatives.
 *
 * **Why batched requests, not one per field**: a per-field query cascades (the
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
  record,
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
   * (each requested target can incur a separate model decision). */
  fieldKeys?: readonly string[];
  /** Existing read projection. Its field resolutions preserve raw inheritance
   * intent while edit-mode suggestions are reviewed as explicit alternatives. */
  record?: unknown;
  children: ReactNode;
}) {
  const form = useFormContext();
  const recordResolutions = useMemo(() => {
    const parsed = resolutionRecordSchema.safeParse(record);
    return parsed.success ? (parsed.data.fieldResolutions ?? {}) : {};
  }, [record]);
  const targets = useMemo(() => {
    const declared = suggestTargetsFor(entity, fieldKeys);
    // A `mode: "prune"` target proposes removing entries from a text-array
    // field, not a value to auto-fill — its review UI needs PR 3's ChipsInput
    // wiring, so a form-surface provider never requests it, even when the
    // field itself is rendered (and so already present in `fieldKeys`).
    // Record surfaces (`RecordSuggestionsProvider`) request it directly
    // instead of mounting this provider (Amendment 3).
    const filtered = declared.targets.filter(
      (target) => target.mode !== "prune",
    );
    const basisKeys = new Set(filtered.flatMap((target) => target.basis));
    return { targets: filtered, basisKeys: [...basisKeys] };
  }, [entity, fieldKeys]);

  const watchedKeys = useMemo(
    () =>
      suggestionContextKeys(entity, targets).filter(
        (key) => !(staticBasis && Object.hasOwn(staticBasis, key)),
      ),
    [entity, targets, staticBasis],
  );
  const watchedPaths = useMemo(
    () => watchedKeys.map((key) => paths?.[key] ?? key),
    [watchedKeys, paths],
  );

  const watchedValues: unknown[] = useWatch({
    control: form.control,
    name: watchedPaths,
  });
  const targetPaths = useMemo(
    () => targets.targets.map((target) => paths?.[target.key] ?? target.key),
    [targets.targets, paths],
  );
  const targetValues: unknown[] = useWatch({
    control: form.control,
    name: targetPaths,
  });
  const targetFormState = useFormState({
    control: form.control,
    name: targetPaths,
  });
  const currentRecordResolutions = useMemo<FieldResolutions>(() => {
    const current: FieldResolutions = {};
    for (const [field, resolution] of Object.entries(recordResolutions)) {
      const path = paths?.[field] ?? field;
      const fieldState = form.getFieldState(path, targetFormState);
      const modeField = resolutionModeField(entity, field);
      const modeState = modeField
        ? form.getFieldState(paths?.[modeField] ?? modeField, targetFormState)
        : null;
      if (
        fieldState.isDirty ||
        fieldState.isTouched ||
        modeState?.isDirty ||
        modeState?.isTouched
      )
        continue;
      current[field] = resolution;
    }
    return current;
  }, [entity, form, paths, recordResolutions, targetFormState]);

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
  const rawBasis = useMemo(() => {
    const snapshot: FieldSuggestionSource["basis"] = {};
    if (staticBasis) Object.assign(snapshot, staticBasis);
    watchedKeys.forEach((key, index) => {
      snapshot[key] = autoFilledRef.current.has(key)
        ? null
        : basisValueOf(watchedValues[index]);
    });
    for (const field of autoFilledRef.current.keys()) {
      snapshot[field] = null;
      const modeField = resolutionModeField(entity, field);
      if (modeField) snapshot[modeField] = "inherit";
    }
    return snapshot;
    // `autoFilledRef` is a ref: its mutations don't participate in React's
    // dependency comparison, but every mutation happens synchronously inside
    // an effect that also touches `watchedValues` (the auto-fill write
    // itself), so this recomputes whenever the ref could have changed.
  }, [entity, watchedKeys, watchedValues, staticBasis]);
  const rawBasisKey = JSON.stringify(rawBasis);
  const [resolutionSnapshot, setResolutionSnapshot] = useState<{
    basisKey: string;
    resolutions: FieldResolutions;
  } | null>(null);
  const authoritativeResolutions = useMemo<FieldResolutions>(() => {
    const resolutions = { ...currentRecordResolutions };
    if (resolutionSnapshot?.basisKey === rawBasisKey) {
      Object.assign(resolutions, resolutionSnapshot.resolutions);
    }
    return resolutions;
  }, [currentRecordResolutions, resolutionSnapshot, rawBasisKey]);
  const basis = useMemo<FieldSuggestionSource["basis"]>(() => {
    if (Object.keys(authoritativeResolutions).length === 0) return rawBasis;
    return {
      ...rawBasis,
      __resolutionContext: JSON.stringify(authoritativeResolutions),
    };
  }, [rawBasis, authoritativeResolutions]);

  const [debouncedBasis] = useDebouncedValue(basis, {
    wait: FIELD_SUGGEST_DEBOUNCE_MS,
  });

  const sufficient = isBasisSufficient(entity, targets, debouncedBasis);
  const basisSettled = JSON.stringify(basis) === JSON.stringify(debouncedBasis);
  const { suggestedTargets, alternativeTargets } = useMemo(() => {
    const suggestedTargets: string[] = [];
    const alternativeTargets: string[] = [];
    targets.targets.forEach((target, index) => {
      if (isAllocatedExpenseProject(entity, target.key, basis)) {
        return;
      }
      const value = basisValueOf(targetValues[index]);
      const state = form.getFieldState(targetPaths[index]!, targetFormState);
      const manuallyChanged = state.isDirty || state.isTouched;
      const resolution = authoritativeResolutions[target.key];
      const untouchedUnresolved = isUntouchedUnresolved({
        mode,
        entity,
        field: target.key,
        value,
        manuallyChanged,
        autoFilled: autoFilledRef.current.has(target.key),
        resolution,
        basis,
      });
      (untouchedUnresolved ? suggestedTargets : alternativeTargets).push(
        target.key,
      );
    });
    return { suggestedTargets, alternativeTargets };
  }, [
    mode,
    entity,
    targets.targets,
    targetValues,
    targetPaths,
    targetFormState,
    form,
    basis,
    authoritativeResolutions,
  ]);
  const suggestedSource = useMemo(
    () =>
      suggestedTargets.length > 0 && sufficient && basisSettled
        ? {
            basisMode: "suggested" as const,
            entity,
            targets: suggestedTargets,
            basis: debouncedBasis,
          }
        : null,
    [entity, suggestedTargets, sufficient, basisSettled, debouncedBasis],
  );
  const alternativeSource = useMemo(
    () =>
      alternativeTargets.length > 0 && sufficient && basisSettled
        ? {
            basisMode: "provided" as const,
            entity,
            targets: alternativeTargets,
            basis: debouncedBasis,
          }
        : null,
    [entity, alternativeTargets, sufficient, basisSettled, debouncedBasis],
  );

  const suggestedQuery = useEntitySuggestionsQuery({
    source: suggestedSource,
    enabled: !disabled,
    operations,
  });
  const alternativeQuery = useEntitySuggestionsQuery({
    source: alternativeSource,
    enabled: !disabled,
    operations,
  });
  useEffect(() => {
    if (
      !basisSettled ||
      suggestedQuery.isFetching ||
      alternativeQuery.isFetching
    )
      return;
    const returned = {
      ...suggestedQuery.fieldResolutions,
      ...alternativeQuery.fieldResolutions,
    };
    if (Object.keys(returned).length === 0) return;
    setResolutionSnapshot((previous) => {
      const resolutions = { ...returned };
      if (previous?.basisKey === rawBasisKey) {
        Object.assign(resolutions, previous.resolutions, returned);
      }
      const next = {
        basisKey: rawBasisKey,
        resolutions,
      };
      return JSON.stringify(previous) === JSON.stringify(next)
        ? previous
        : next;
    });
  }, [
    suggestedQuery.fieldResolutions,
    alternativeQuery.fieldResolutions,
    rawBasisKey,
    basisSettled,
    suggestedQuery.isFetching,
    alternativeQuery.isFetching,
  ]);
  const suggestions = useMemo(
    () => ({
      ...suggestedQuery.suggestions,
      ...alternativeQuery.suggestions,
    }),
    [suggestedQuery.suggestions, alternativeQuery.suggestions],
  );
  const liveResolutions = useMemo<FieldResolutions>(
    () => ({
      ...authoritativeResolutions,
      ...suggestedQuery.fieldResolutions,
      ...alternativeQuery.fieldResolutions,
    }),
    [
      authoritativeResolutions,
      suggestedQuery.fieldResolutions,
      alternativeQuery.fieldResolutions,
    ],
  );
  const isFetching = suggestedQuery.isFetching || alternativeQuery.isFetching;

  const value = useMemo<FieldSuggestionContextValue>(
    () => ({
      questionKey: JSON.stringify([suggestedSource, alternativeSource]),
      entity,
      mode,
      suggestions:
        JSON.stringify(basis) === JSON.stringify(debouncedBasis)
          ? suggestions
          : {},
      isFetching:
        isFetching || JSON.stringify(basis) !== JSON.stringify(debouncedBasis),
      resolutionFor: (field) => liveResolutions[field] ?? null,
      isAlternative: (field) => alternativeTargets.includes(field),
      markAutoFilled,
      clearAutoFilled,
      isAutoFilled,
    }),
    [
      suggestedSource,
      alternativeSource,
      basis,
      debouncedBasis,
      entity,
      mode,
      suggestions,
      isFetching,
      liveResolutions,
      alternativeTargets,
      markAutoFilled,
      clearAutoFilled,
      isAutoFilled,
    ],
  );

  return (
    <SuggestionVisitProvider>
      <FieldSuggestionContext.Provider value={value}>
        {(suggestedSource || alternativeSource) && value.isFetching ? (
          <Description size="xs" as="output">
            Checking suggestions…
          </Description>
        ) : null}
        {children}
      </FieldSuggestionContext.Provider>
    </SuggestionVisitProvider>
  );
}
