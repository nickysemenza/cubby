"use client";

import { ReactNode } from "react";
import { Button, ButtonVariants } from "~/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "~/components/ui/form";
import { UseFormReturn, FieldValues, Path, PathValue } from "react-hook-form";
import { Input } from "~/components/ui/input";
import { ComboboxItem } from "./combobox/combobox-types";
import { DevTool } from "@hookform/devtools";
import { DialogCompatibleCombobox } from "./combobox/combobox-dialog";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

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
  submitButtonVariant?: ButtonVariants["variant"];
  children: ReactNode;
}) {
  return (
    <Form {...form}>
      <DevTool control={form.control} />
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
    </Form>
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
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className="space-y-1">
          <FormLabel className="text-sm">{label}</FormLabel>
          <FormControl>
            <Textarea
              placeholder={placeholder}
              {...field}
              className="min-h-0 px-2 py-1"
              rows={rows}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
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
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
  step?: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              step={step}
              placeholder={placeholder}
              {...field}
              value={
                (field.value as number | null) !== null
                  ? (field.value as number).toString()
                  : ""
              }
              onChange={(e) => {
                const value = e.target.value;
                const numberValue = value ? parseFloat(value) : null;
                field.onChange(
                  numberValue as PathValue<TFieldValues, Path<TFieldValues>>,
                );
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// Helper for handling combobox fields
export function ComboboxField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  findItems,
  onCreateNew,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  findItems: (query: string) => Promise<ComboboxItem[]>;
  onCreateNew?: (name: string) => Promise<ComboboxItem>;
  insideDialog?: boolean;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <DialogCompatibleCombobox
              label={label.toLowerCase()}
              findItems={findItems}
              value={field.value as ComboboxItem | null}
              setValue={(value) =>
                field.onChange(
                  value as PathValue<TFieldValues, Path<TFieldValues>>,
                )
              }
              onCreateNew={onCreateNew}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
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
export function detectComboboxIdChange(
  entityId: string | undefined | null,
  comboboxItem: ComboboxItem | null | undefined,
): string | null | undefined {
  if (entityId === null && !comboboxItem) {
    return undefined; // No change if both are null/empty
  }
  if (entityId === null && comboboxItem) {
    return comboboxItem.id; // Set new ID if entity was null
  }
  if (entityId !== null && !comboboxItem) {
    return null; // Set to null if removing association
  }
  if (comboboxItem && comboboxItem.id !== entityId) {
    return comboboxItem.id; // Change ID if different
  }
  return undefined; // No change
}

// Helper to build a common form layout with two fields side by side
export function SideBySideFields({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex space-x-4">
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
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => {
        const value = nullable
          ? (field.value as string | null) || ""
          : field.value;
        const icon = getIcon
          ? getIcon(nullable ? (field.value as string | null) : field.value)
          : null;
        return (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <div className="relative">
              <FormControl>
                <Input
                  placeholder={placeholder}
                  {...field}
                  value={value}
                  onChange={(e) => {
                    const v = e.target.value;
                    field.onChange(nullable ? (v === "" ? null : v) : v);
                  }}
                  className={icon ? "pr-10" : undefined}
                />
              </FormControl>
              {icon && (
                <span className="absolute inset-y-0 right-3 flex items-center">
                  {icon}
                </span>
              )}
            </div>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

// Helper for handling select fields
export function SelectField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  options,
  placeholder,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Select
              onValueChange={field.onChange}
              value={field.value}
              defaultValue={field.value}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={placeholder || `Select ${label.toLowerCase()}`}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
