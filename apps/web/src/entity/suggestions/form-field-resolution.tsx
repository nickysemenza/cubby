import type { Entity } from "@cubby/schemas/entity";
import {
  fieldDecisionOf,
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useEntityMetadata } from "~/entity/metadata";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/catalog/fieldExplanation.gen";
import { DecisionValue } from "~/ui/derived/decision-chain";
import { ResolutionEvidence } from "~/ui/derived/resolution-evidence";
import { SourceStack } from "~/ui/derived/source-stack";
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
  return resolvedEntity ? (
    <BoundFormFieldResolution
      form={form}
      field={field}
      entity={resolvedEntity}
    />
  ) : null;
}

function BoundFormFieldResolution<TValues extends FieldValues>({
  form,
  field,
  entity: resolvedEntity,
}: {
  form: UseFormReturn<TValues>;
  field: string;
  entity: Entity;
}) {
  const context = useFieldSuggestionContext();
  const metadata = useEntityMetadata(resolvedEntity);
  const [open, setOpen] = useState(false);
  const policy = useMemo(
    () =>
      metadata.fields.fields.find((candidate) => candidate.key === field)
        ?.resolution,
    [metadata, field],
  );
  // SAFETY: `field` comes from the mounted entity's declared form field model.
  const name = field as Path<TValues>;
  const value: unknown = useWatch({ control: form.control, name });
  const formState = useFormState({ control: form.control });
  const savedBasis = !formState.isDirty;
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

  const explanationQueries: ReturnType<
    typeof fieldExplanation.explain.queryOptions
  >[] =
    open && savedBasis && resolvedEntity && context?.entityId
      ? [
          {
            ...fieldExplanation.explain.queryOptions({
              entityKind: resolvedEntity,
              entityId: context.entityId,
              field,
              surface: "detail",
            }),
            staleTime: 0,
            refetchOnMount: "always" as const,
          },
        ]
      : [];
  const explanations = useQueries({ queries: explanationQueries });
  if (!policy) return null;
  const resolution =
    (savedBasis ? explanations[0]?.data?.envelope : null) ??
    context?.resolutionFor(field);
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
    resolution &&
    !(
      resolution.current.controls.kind === "editable" &&
      resolution.current.controls.reset.kind === "available"
    ) ? null : (
      <Button
        type="button"
        size="xs"
        variant="link"
        className={resolutionActionClassName}
        onClick={() => applyPatch(policy.reset)}
      >
        Use inherited
      </Button>
    );
  const ownAction =
    nonePatch &&
    (!resolution ||
      (resolution.current.controls.kind === "editable" &&
        resolution.current.controls.canSetNone)) &&
    resolution?.current.assignment?.kind !== "none" ? (
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="link" size="xs" />}
      >
        Why this value
      </PopoverTrigger>
      <PopoverContent className="max-h-[85dvh] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto">
        <PopoverTitle>Why this value</PopoverTitle>
        <div className="grid gap-2 pt-2">
          <h3 className="text-xs font-medium">Your choice</h3>
          <DecisionValue
            entity={resolvedEntity}
            field={field}
            value={value ?? null}
          />
          <div className="flex gap-2">
            {ownAction}
            {inheritedAction}
          </div>
          {resolution?.current.controls.kind === "editable" &&
          resolution.current.controls.canConfirm &&
          policy.confirm ? (
            <Button
              type="button"
              size="xs"
              variant="link"
              onClick={() =>
                applyPatch({
                  ...policy.confirm,
                  [field]: resolution ? fieldValueOf(resolution) : null,
                })
              }
            >
              Keep this value
            </Button>
          ) : null}
          {resolution?.current.controls.kind === "editable" &&
          resolution.current.controls.reset.kind === "available" &&
          resolution.current.controls.reset.preview.kind === "ready" ? (
            <SourceStack
              rows={[
                {
                  key: "reset",
                  status: "deciding",
                  title: "With inherited values",
                  children: (
                    <DecisionValue
                      entity={resolvedEntity}
                      field={field}
                      value={fieldValueOf({
                        result:
                          resolution.current.controls.reset.preview.result,
                      })}
                    />
                  ),
                },
              ]}
            />
          ) : null}
          <FormResolutionSource
            resolution={resolution}
            explanation={savedBasis ? explanations[0]?.data : undefined}
            entity={resolvedEntity}
            field={field}
          />
          {explanations[0]?.isFetching ? (
            <p className="text-xs text-muted-foreground">
              Loading source preview…
            </p>
          ) : null}
          {explanations[0]?.error ? (
            <p role="alert" className="text-xs text-destructive">
              {explanations[0]?.error.message}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FormResolutionSource({
  resolution,
  explanation,
  entity,
  field,
}: {
  resolution: ReadableFieldEnvelope | null | undefined;
  explanation: FieldExplanationOutput | undefined;
  entity: Entity | undefined;
  field: string;
}) {
  if (explanation?.resolutionEvidence)
    return <ResolutionEvidence evidence={explanation.resolutionEvidence} />;
  const provenance = resolution
    ? fieldDecisionOf(resolution)?.provenance
    : null;
  const source =
    provenance?.kind === "inherited" || provenance?.kind === "default"
      ? provenance.source
      : null;
  if (!source) return null;
  return (
    <SourceStack
      rows={[
        {
          key: source.entityId,
          title: (
            <ExplanationEntityLink
              entity={source.entityKind}
              id={source.entityId}
              name={source.name ?? undefined}
            />
          ),
          status:
            resolution?.result.kind === "cached" &&
            resolution.result.freshness === "stale"
              ? "skipped"
              : "deciding",
          children: (
            <DecisionValue
              entity={entity}
              field={field}
              value={resolution ? fieldValueOf(resolution) : null}
            />
          ),
        },
      ]}
    />
  );
}
