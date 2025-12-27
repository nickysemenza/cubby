import { DevTool } from "@hookform/devtools";
import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import {
  Controller,
  type FieldValues,
  FormProvider,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";
import { Button, type buttonVariants } from "~/components/ui/button";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { DialogCompatibleCombobox } from "./combobox/combobox-dialog";
import type { ComboboxItem } from "./combobox/combobox-types";

// Base props shared by all forms
interface BaseFormProps {
  isPending: boolean;
  error?: string;
  onCancel?: () => void;
}

// Generic create mode props
export interface CreateModeProps<TCreateData> extends BaseFormProps {
  mode: "create";
  onCreate: (data: TCreateData) => void;
  onEdit?: never;
  // The entity property will be specified in the consuming component
}

// Generic edit mode props
export interface EditModeProps<TEditData, TEntity> extends BaseFormProps {
  mode: "edit";
  onEdit: (data: TEditData) => void;
  onCreate?: never;
  entity: TEntity;
}

// Helper function to generate submit button text based on mode and pending state
export function getSubmitButtonText(
  mode: "create" | "edit",
  isPending: boolean,
): string {
  return mode === "create"
    ? isPending
      ? "Creating..."
      : "Create"
    : isPending
      ? "Saving..."
      : "Save";
}

// Form wrapper component with common layout and buttons
export function FormWrapper<TFieldValues extends FieldValues = FieldValues>({
  form,
  onSubmit,
  error,
  isPending,
  onCancel,
  submitButtonText,
  submitButtonVariant = "default",
  children,
}: {
  form: UseFormReturn<TFieldValues>;
  onSubmit: (values: TFieldValues) => void;
  error?: string;
  isPending: boolean;
  onCancel?: () => void;
  submitButtonText: string;
  submitButtonVariant?: VariantProps<typeof buttonVariants>["variant"];
  children: ReactNode;
}) {
  return (
    <FormProvider {...form}>
      {process.env.NODE_ENV !== "production" ? (
        <DevTool control={form.control} />
      ) : null}
      <form
        onSubmit={(e) => {
          // https://github.com/orgs/react-hook-form/discussions/7038#discussioncomment-11376398
          e.stopPropagation();
          e.preventDefault();
          form.handleSubmit(onSubmit)(e);
        }}
        className="space-y-4"
      >
        {children}

        {error && <div className="text-destructive text-sm">{error}</div>}

        <div className="flex justify-end space-x-2">
          <Button
            type="submit"
            disabled={isPending}
            variant={submitButtonVariant}
          >
            {submitButtonText}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}

// Helper for handling required textarea fields
export function RequiredTextareaField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
  rows = 3,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
  rows?: number;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Textarea
            id={name}
            placeholder={placeholder}
            {...field}
            className="min-h-0 px-2 py-1"
            rows={rows}
            aria-invalid={fieldState.invalid}
          />
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

// Helper for handling nullable numeric fields with number input type
export function NullableNumericField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
  step = "1",
  prefix,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
  step?: string;
  prefix?: string;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const inputProps = {
          id: name,
          type: "number" as const,
          step,
          placeholder,
          ...field,
          value:
            (field.value as number | null) !== null
              ? (field.value as number).toString()
              : "",
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const value = e.target.value;
            const numberValue = value ? parseFloat(value) : null;
            field.onChange(
              numberValue as PathValue<TFieldValues, Path<TFieldValues>>,
            );
          },
          "aria-invalid": fieldState.invalid,
        };

        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={name}>{label}</FieldLabel>
            {prefix ? (
              <div className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                  {prefix}
                </span>
                <Input {...inputProps} className="pl-7" />
              </div>
            ) : (
              <Input {...inputProps} />
            )}
            {fieldState.error && <FieldError errors={[fieldState.error]} />}
          </Field>
        );
      }}
    />
  );
}

// Helper for handling combobox fields
export function ComboboxField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  items,
  onSearchChange,
  isLoading,
  onCreateNew,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label?: string;
  items: ComboboxItem[];
  onSearchChange: (query: string) => void;
  isLoading?: boolean;
  onCreateNew?: (name: string) => Promise<ComboboxItem>;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          {label && <FieldLabel htmlFor={name}>{label}</FieldLabel>}
          <DialogCompatibleCombobox
            label={label?.toLowerCase() ?? "item"}
            items={items}
            onSearchChange={onSearchChange}
            isLoading={isLoading}
            value={field.value as ComboboxItem | null}
            setValue={(value) =>
              field.onChange(
                value as PathValue<TFieldValues, Path<TFieldValues>>,
              )
            }
            onCreateNew={onCreateNew}
          />
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

// Generic function to build an update object based on changed fields
export function buildUpdateObject<
  T extends Record<string, unknown>,
  F extends Record<string, unknown>,
>(
  entity: T,
  formValues: F,
  fields: Array<string & keyof T & keyof F>,
): Partial<T> {
  const updates: Partial<T> = {};

  fields.forEach((field) => {
    const entityValue = entity[field];
    const formValue = formValues[field];
    if (JSON.stringify(entityValue) !== JSON.stringify(formValue)) {
      updates[field] = formValue as unknown as T[typeof field];
    }
  });

  return updates;
}

// Helper to extract ID from a ComboboxItem if different from entity
// Generic version that preserves ID type branding
// Accepts either branded or unbranded combobox items for flexibility with form values
export function detectComboboxIdChange<TId extends string>(
  entityId: TId | string | undefined | null,
  comboboxItem: ComboboxItem | null | undefined,
): TId | null | undefined {
  if (entityId === null && !comboboxItem) {
    return undefined; // No change if both are null/empty
  }
  if (entityId === null && comboboxItem) {
    return comboboxItem.id as TId; // Set new ID if entity was null
  }
  if (entityId !== null && !comboboxItem) {
    return null; // Set to null if removing association
  }
  if (comboboxItem && comboboxItem.id !== entityId) {
    return comboboxItem.id as TId; // Change ID if different
  }
  return undefined; // No change
}

// Helper to build a common form layout with two fields side by side
export function SideBySideFields({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={cn("flex space-x-4", className)}>
      <div className="flex-1">
        {Array.isArray(children) ? children[0] : children}
      </div>
      <div className="flex-1">
        {Array.isArray(children) && children.length > 1 ? children[1] : null}
      </div>
    </div>
  );
}

// Unified text field component that combines nullable and required functionality
export function UnifiedTextField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
  nullable = false,
  getIcon,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
  nullable?: boolean;
  getIcon?: (value: string | null) => ReactNode;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const value = nullable
          ? (field.value as string | null) || ""
          : field.value;
        const icon = getIcon
          ? getIcon(nullable ? (field.value as string | null) : field.value)
          : null;
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={name}>{label}</FieldLabel>
            <div className="relative">
              <Input
                id={name}
                placeholder={placeholder}
                {...field}
                value={value}
                onChange={(e) => {
                  const v = e.target.value;
                  field.onChange(nullable ? (v === "" ? null : v) : v);
                }}
                className={icon ? "pr-10" : undefined}
                aria-invalid={fieldState.invalid}
              />
              {icon && (
                <span className="absolute inset-y-0 right-3 flex items-center">
                  {icon}
                </span>
              )}
            </div>
            {fieldState.error && <FieldError errors={[fieldState.error]} />}
          </Field>
        );
      }}
    />
  );
}

// Re-export ComboboxFieldWithSearch from its dedicated file
export { ComboboxFieldWithSearch } from "./form-utils/combobox-field-with-search";

// Sentinel value for "none" in select (Radix doesn't support empty string values)
const SELECT_NONE_VALUE = "__none__";

// Helper for handling select fields
export function SelectField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  options,
  placeholder,
  nullable = false,
  disabled = false,
  description,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  nullable?: boolean;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Select
            onValueChange={(value) =>
              field.onChange(value === SELECT_NONE_VALUE ? null : value)
            }
            value={field.value ?? (nullable ? SELECT_NONE_VALUE : undefined)}
            defaultValue={
              field.value ?? (nullable ? SELECT_NONE_VALUE : undefined)
            }
            disabled={disabled}
          >
            <SelectTrigger id={name} aria-invalid={fieldState.invalid}>
              <SelectValue
                placeholder={placeholder || `Select ${label.toLowerCase()}`}
              />
            </SelectTrigger>
            <SelectContent>
              {nullable && (
                <SelectItem value={SELECT_NONE_VALUE}>
                  <span className="text-muted-foreground">None</span>
                </SelectItem>
              )}
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}
