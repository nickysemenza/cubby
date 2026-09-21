import {
  Controller,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";

import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";

/** Small structured editors for finance evidence.  These deliberately expose
 * source-owned fields rather than a JSON textarea: array updates replace the
 * complete value, so their contents stay intelligible at review time. */
export function SourceAliasesField<T extends FieldValues>({
  form,
}: {
  form: UseFormReturn<T>;
}) {
  return (
    <ArrayFieldManager<
      { source: string; alias: string; externalAccountId: string | null },
      T
    >
      form={form}
      name="sourceAliases"
      title="Source aliases"
      addButtonText="Add alias"
      emptyValue={{ source: "", alias: "", externalAccountId: null }}
      columns={[
        { label: "Source" },
        { label: "Alias" },
        { label: "External ID" },
      ]}
    >
      {(_item, index) => (
        <>
          <TextField
            form={form}
            name={`sourceAliases.${index}.source`}
            label="Source"
            hideLabel
          />
          <TextField
            form={form}
            name={`sourceAliases.${index}.alias`}
            label="Alias"
            hideLabel
          />
          <TextField
            form={form}
            name={`sourceAliases.${index}.externalAccountId`}
            label="External ID"
            hideLabel
          />
        </>
      )}
    </ArrayFieldManager>
  );
}

export function SourceRefsField<T extends FieldValues>({
  form,
}: {
  form: UseFormReturn<T>;
}) {
  return (
    <ArrayFieldManager<{ source: string; externalId: string }, T>
      form={form}
      name="sourceRefs"
      title="Source references"
      addButtonText="Add reference"
      emptyValue={{ source: "", externalId: "" }}
      columns={[{ label: "Source" }, { label: "External ID" }]}
    >
      {(_item, index) => (
        <>
          <TextField
            form={form}
            name={`sourceRefs.${index}.source`}
            label="Source"
            hideLabel
          />
          <TextField
            form={form}
            name={`sourceRefs.${index}.externalId`}
            label="External ID"
            hideLabel
          />
        </>
      )}
    </ArrayFieldManager>
  );
}

export function TextField<T extends FieldValues>({
  form,
  name,
  label,
  type = "text",
  hideLabel = false,
}: {
  form: UseFormReturn<T>;
  name: string;
  label: string;
  type?: string;
  /** Skip the visible label — a `columns` array row already shows it as a
   * header; the label still reaches assistive tech via `aria-label`. */
  hideLabel?: boolean;
}) {
  return (
    <Controller
      control={form.control}
      // SAFETY: TextField deliberately accepts a caller-owned path string;
      // React Hook Form cannot correlate that dynamic path with T here.
      name={name as never}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          label={hideLabel ? undefined : label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Input
            {...field}
            type={type}
            aria-label={hideLabel ? label : undefined}
            value={field.value ?? ""}
            onChange={(event) =>
              field.onChange(
                type === "number"
                  ? event.target.value === ""
                    ? 0
                    : event.target.valueAsNumber
                  : event.target.value,
              )
            }
            className="min-w-28 flex-1"
          />
        </FormFieldGroup>
      )}
    />
  );
}

export function SelectField<T extends FieldValues>({
  form,
  name,
  label,
  values,
}: {
  form: UseFormReturn<T>;
  name: string;
  label: string;
  values: readonly string[];
}) {
  return (
    <Controller
      control={form.control}
      // SAFETY: SelectField deliberately accepts a caller-owned path string;
      // React Hook Form cannot correlate that dynamic path with T here.
      name={name as never}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <NativeSelect
            className="w-full"
            value={field.value ?? ""}
            onChange={(event) => field.onChange(event.target.value)}
          >
            <option value="">Select…</option>
            {values.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </NativeSelect>
        </FormFieldGroup>
      )}
    />
  );
}
