/**
 * Shared destination-location picker for the inventory "move" surfaces
 * (MoveInventoryDialog and session MoveToDialog).
 *
 * They all chose a target location, surfaced a validation error, and enforced
 * "destination must differ from source" — with three different user-facing
 * strings. This module factors out the common field + validation while letting
 * each caller keep its exact copy via the `messages` override.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useState } from "react";
import {
  type FieldPathByValue,
  type FieldValues,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import { z } from "zod";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  getOptionalLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import { Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";

const destinationFormSchema = z.object({
  targetLocation: optionalLocationField,
});

type DestinationFormValues = z.infer<typeof destinationFormSchema>;
// Form schemas store picker ids as strings; the destination resolver parses
// the selected id into a LocationShortcode at the command boundary.
type LocationPickerValue = ComboboxItem | null | undefined;
type LocationPickerPath<TFieldValues extends FieldValues> = FieldPathByValue<
  TFieldValues,
  LocationPickerValue
>;

/**
 * Presentational destination field: the location combobox plus the inline
 * StatusText error block. Callers keep their own FormProvider / FormWrapper.
 *
 * Omit `error` when the surrounding surface renders errors elsewhere.
 */
export function DestinationLocationField<
  TFieldValues extends FieldValues,
  TName extends LocationPickerPath<TFieldValues>,
>({
  form,
  name,
  label,
  error,
  sourceLocationIds,
}: {
  form: UseFormReturn<TFieldValues>;
  name: TName;
  label: string;
  error?: string | null;
  sourceLocationIds?: LocationShortcode | LocationShortcode[];
}) {
  const sources = sourceLocationIds
    ? Array.isArray(sourceLocationIds)
      ? sourceLocationIds
      : [sourceLocationIds]
    : [];
  const disabledItemReasons = Object.fromEntries(
    sources.map((source) => [source, "Already the current location"]),
  );
  return (
    <Stack gap="md">
      <ComboboxFieldWithSearch
        form={form}
        name={name}
        label={label}
        searchType="location"
        disabledItemReasons={disabledItemReasons}
      />
      {error && (
        <StatusText as="div" tone="destructive" className="text-sm">
          {error}
        </StatusText>
      )}
    </Stack>
  );
}

export interface DestinationMessages {
  /** Shown when no destination is selected. */
  missingTarget: string;
  /** Shown when the destination matches a source location. */
  sameAsSource: string;
}

export type ResolveDestinationResult =
  | { ok: true; id: LocationShortcode }
  | { ok: false; error: string };

/**
 * Validates a chosen destination combobox value: it must be non-empty and must
 * differ from every source location. `messages` is required (no defaults —
 * every caller has its own established copy, and unreachable fallback strings
 * would rot).
 */
export function resolveDestination(
  target: ComboboxItem | null | undefined,
  sourceLocationIds: LocationShortcode | LocationShortcode[],
  messages: DestinationMessages,
): ResolveDestinationResult {
  const id = getOptionalLocationId(target);
  if (!id) {
    return { ok: false, error: messages.missingTarget };
  }

  const sources = Array.isArray(sourceLocationIds)
    ? sourceLocationIds
    : [sourceLocationIds];
  if (sources.includes(id)) {
    return { ok: false, error: messages.sameAsSource };
  }

  return { ok: true, id };
}

/**
 * The single-field destination form + error state used by the two move dialogs.
 * `reset` clears both the form and the error.
 */
export function useDestinationLocationForm() {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<DestinationFormValues>({
    resolver: zodResolver(destinationFormSchema),
    defaultValues: { targetLocation: null },
  });

  const reset = useCallback(() => {
    form.reset();
    setError(null);
  }, [form]);

  return { form, error, setError, reset };
}
