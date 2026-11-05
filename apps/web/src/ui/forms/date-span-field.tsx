import { dateRangeSchema, dateRangeFromDates } from "@cubby/schemas/date-range";
import { useId } from "react";
import {
  Controller,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import { DateSpanInput } from "~/ui/date-span-input";
import { FieldError } from "~/ui/primitives/field";

import { FormFieldGroup } from "./form-field-group";

// Keep invalid endpoint ordering visible while the form reports its schema error.
const editableRange = z.object(dateRangeSchema.shape).nullish();

export function DateRangeField({
  form,
  name,
  label,
  clearable,
  semantics,
}: {
  form: UseFormReturn<FieldValues>;
  name: string;
  label: string;
  clearable: boolean;
  semantics: "deadline" | "period";
}) {
  const id = useId();
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const value = editableRange.parse(field.value);
        return (
          <FormFieldGroup
            htmlFor={id}
            label={label}
            invalid={fieldState.invalid}
          >
            <DateSpanInput
              id={id}
              label={label}
              semantics={semantics}
              start={value?.start ?? null}
              end={value?.end ?? null}
              clearable={clearable}
              invalid={fieldState.invalid}
              describedBy={fieldState.error ? `${id}-error` : undefined}
              inputRef={field.ref}
              onBlur={field.onBlur}
              onChange={({ start, end }) =>
                field.onChange(dateRangeFromDates(start, end))
              }
            />
            <FieldError id={`${id}-error`} errors={[fieldState.error]} />
          </FormFieldGroup>
        );
      }}
    />
  );
}
