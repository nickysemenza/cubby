/**
 * Shared destination-location picker for the three inventory "move" surfaces
 * (MoveInventoryDialog, session MoveToDialog, and the bulk-move page).
 *
 * All three chose a target location, surfaced a validation error, and enforced
 * "destination must differ from source" — with three different user-facing
 * strings. This module factors out the common field + validation while letting
 * each caller keep its exact copy via the `messages` override.
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useState } from "react";
import {
  type FieldValues,
  type Path,
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

/**
 * Presentational destination field: the location combobox plus the inline
 * StatusText error block. Callers keep their own FormProvider / FormWrapper.
 *
 * Omit `error` when the surrounding surface renders errors elsewhere
 * (e.g. bulk-move's FormWrapper `error` prop).
 */
export function DestinationLocationField<TFieldValues extends FieldValues>({
  form,
  name,
  label,
  error,
}: {
  form: UseFormReturn<TFieldValues>;
  /** Defaults to `"targetLocation"`. */
  name?: Path<TFieldValues>;
  label: string;
  error?: string | null;
}) {
  const fieldName = name ?? ("targetLocation" as Path<TFieldValues>);
  return (
    <Stack gap="md">
      <ComboboxFieldWithSearch
        form={form}
        name={fieldName}
        label={label}
        searchType="location"
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
  | { ok: true; id: LocationId }
  | { ok: false; error: string };

/**
 * Validates a chosen destination combobox value: it must be non-empty and must
 * differ from every source location. `messages` is required (no defaults —
 * every caller has its own established copy, and unreachable fallback strings
 * would rot).
 */
export function resolveDestination(
  target: ComboboxItem | null | undefined,
  sourceLocationIds: LocationId | LocationId[],
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
