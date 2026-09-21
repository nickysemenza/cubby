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

import { Button } from "~/components/ui/button";
import { FieldResolutionStatus } from "~/entities/field-resolution";

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
  const actions = (
    <span className="inline-flex items-center gap-1">
      {resolution?.mode === "inherit" ? null : (
        <Button
          type="button"
          size="xs"
          variant="link"
          onClick={() => applyPatch(policy.reset)}
        >
          Use inherited
        </Button>
      )}
      {nonePatch && resolution?.mode !== "none" ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => applyPatch(nonePatch)}
        >
          None
        </Button>
      ) : null}
    </span>
  );
  return resolution ? (
    <FieldResolutionStatus resolution={resolution} action={actions} />
  ) : (
    actions
  );
}
