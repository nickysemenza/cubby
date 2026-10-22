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

const dateValue = z
  .string()
  .nullish()
  .transform((value) => value || null);

/** Both canonical fields remain registered, including the hidden end's errors/focus. */
export function DateSpanField({
  form,
  startName,
  endName,
  label,
  clearable,
}: {
  form: UseFormReturn<FieldValues>;
  startName: string;
  endName: string;
  label: string;
  clearable: boolean;
}) {
  const id = useId();
  const errorId = `${id}-errors`;
  return (
    <Controller
      control={form.control}
      name={startName}
      render={({ field: start, fieldState: startState }) => (
        <Controller
          control={form.control}
          name={endName}
          render={({ field: end, fieldState: endState }) => {
            const invalid = Boolean(startState.error || endState.error);
            return (
              <FormFieldGroup htmlFor={id} label={label} invalid={invalid}>
                <DateSpanInput
                  id={id}
                  label={label}
                  start={dateValue.parse(start.value)}
                  end={dateValue.parse(end.value)}
                  clearable={clearable}
                  invalid={invalid}
                  describedBy={invalid ? errorId : undefined}
                  inputRef={(node) => {
                    start.ref(node);
                    end.ref(node);
                  }}
                  onBlur={() => {
                    start.onBlur();
                    end.onBlur();
                  }}
                  onChange={(value) => {
                    if (value.start !== dateValue.parse(start.value))
                      start.onChange(value.start);
                    if (value.end !== dateValue.parse(end.value))
                      end.onChange(value.end);
                  }}
                />
                <FieldError
                  id={errorId}
                  errors={[startState.error, endState.error]}
                />
              </FormFieldGroup>
            );
          }}
        />
      )}
    />
  );
}
