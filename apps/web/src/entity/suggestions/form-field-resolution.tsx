import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { useEffect, useMemo, useRef } from "react";
import {
  type FieldValues,
  type Path,
  type PathValue,
  type UseFormReturn,
  useFormState,
  useWatch,
} from "react-hook-form";
import { z } from "zod";

import { resolutionActionClassName } from "~/entity/fields/field-resolution";
import { DecisionValue } from "~/ui/derived/decision-chain";
import { DecisionLevels } from "~/ui/derived/decision-levels";
import { resolutionDecidedBy } from "~/ui/derived/meta";
import { ExplanationEntityLink } from "~/ui/derived/why-value";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";

import { useFieldSuggestionContext } from "./field-suggestion-provider";

const patchSchema = z.record(z.string(), z.json());

/** Form-local inheritance controls. Resolution policies remain manifest data;
 * this component only translates their reset/none patches into dirty RHF
 * writes so create and edit submit through the ordinary intent mutation. */
export function FormFieldResolution<TValues extends FieldValues>({
  form,
  field,
  entity,
}: {
  form: UseFormReturn<TValues>;
  field: string;
  entity?: Entity;
}) {
  const context = useFieldSuggestionContext();
  const resolvedEntity = entity ?? context?.entity;
  const policy = useMemo(
    () =>
      resolvedEntity
        ? entityFieldModels[resolvedEntity].fields.find(
            (candidate) => candidate.key === field,
          )?.resolution
        : null,
    [resolvedEntity, field],
  );
  // SAFETY: `field` comes from the mounted entity's declared form field model.
  const name = field as Path<TValues>;
  const value: unknown = useWatch({ control: form.control, name });
  const formState = useFormState({ control: form.control, name });
  const changed = form.getFieldState(name, formState);
  const previousValue = useRef(JSON.stringify(value));
  const actionValue = useRef<string | undefined>(undefined);

  const nonePatch = useMemo(
    () => (policy?.none ? patchSchema.parse(policy.none) : null),
    [policy],
  );

  useEffect(() => {
    const serialized = JSON.stringify(value);
    if (serialized === previousValue.current) return;
    previousValue.current = serialized;
    if (actionValue.current === serialized) {
      actionValue.current = undefined;
      return;
    }
    if (!(changed.isDirty || changed.isTouched) || !nonePatch) return;
    for (const [key, next] of Object.entries(nonePatch)) {
      if (key === field) continue;
      // SAFETY: the declaration-owned resolution patch is parsed above and
      // names fields in the same generated intent as this form.
      form.setValue(
        key as Path<TValues>,
        next as PathValue<TValues, Path<TValues>>,
        { shouldDirty: true },
      );
    }
  }, [changed.isDirty, changed.isTouched, field, form, nonePatch, value]);

  if (!policy) return null;
  const resolution = context?.resolutionFor(field);
  const applyPatch = (input: unknown) => {
    const patch = patchSchema.parse(input);
    if (Object.hasOwn(patch, field)) {
      actionValue.current = JSON.stringify(patch[field]);
    }
    context?.clearAutoFilled(field);
    for (const [key, next] of Object.entries(patch)) {
      // SAFETY: the declaration-owned resolution patch is parsed above and
      // names fields in the same generated intent as this form.
      form.setValue(
        key as Path<TValues>,
        next as PathValue<TValues, Path<TValues>>,
        { shouldDirty: true, shouldTouch: true },
      );
    }
  };
  const inheritedAction =
    resolution && !resolution.canReset ? null : (
      <Button
        type="button"
        size="xs"
        variant="link"
        className={resolutionActionClassName}
        onClick={() => applyPatch(policy.reset)}
      >
        {resolution?.fallbackValue === null ? "Clear value" : "Use inherited"}
      </Button>
    );
  const ownAction =
    nonePatch && resolution?.mode !== "none" ? (
      <Button
        type="button"
        size="xs"
        variant="link"
        className={resolutionActionClassName}
        onClick={() => applyPatch(nonePatch)}
      >
        Set to none
      </Button>
    ) : null;
  const deciding = resolution
    ? resolutionDecidedBy(resolution).level
    : undefined;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="link" size="xs" />}
      >
        Why this value
      </PopoverTrigger>
      <PopoverContent className="max-h-[85dvh] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto">
        <PopoverTitle>Why this value</PopoverTitle>
        <DecisionLevels deciding={deciding}>
          {(level) => (
            <>
              {level === "own" ? (
                <>
                  <DecisionValue
                    entity={resolvedEntity}
                    field={field}
                    value={resolution?.storedValue ?? null}
                  />
                  {ownAction}
                </>
              ) : null}
              {level === "inherited" ? (
                <>
                  {resolution?.sourceEntity ? (
                    <ExplanationEntityLink
                      entity={resolution.sourceEntity.entityKind}
                      id={resolution.sourceEntity.entityId}
                      name={resolution.sourceEntity.name}
                    />
                  ) : null}
                  {resolution?.fallbackValue !== null &&
                  resolution?.fallbackValue !== undefined ? (
                    <DecisionValue
                      entity={resolvedEntity}
                      field={field}
                      value={resolution.fallbackValue}
                    />
                  ) : null}
                  {inheritedAction}
                </>
              ) : null}
              {level === "default" && deciding === "default" ? (
                <DecisionValue
                  entity={resolvedEntity}
                  field={field}
                  value={resolution?.value ?? null}
                />
              ) : null}
            </>
          )}
        </DecisionLevels>
      </PopoverContent>
    </Popover>
  );
}
