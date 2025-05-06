"use client";

import { ReactNode } from "react";
import { Button } from "~/components/ui/button";
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
import { Combobox, ComboboxItem } from "./combobox";
import { DevTool } from "@hookform/devtools";

// Base props shared by all forms
export interface BaseFormProps {
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
  children,
}: {
  form: UseFormReturn<TFieldValues>;
  onSubmit: (values: TFieldValues) => void;
  error?: string;
  isPending: boolean;
  onCancel?: () => void;
  submitButtonText: string;
  children: ReactNode;
}) {
  return (
    <Form {...form}>
      <DevTool control={form.control} />
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {children}

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex space-x-2">
          <Button type="submit" disabled={isPending}>
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

// Helper for handling nullable text fields
export function NullableTextField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
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
              placeholder={placeholder}
              {...field}
              value={(field.value as string | null) || ""}
              onChange={(e) => {
                const value = e.target.value;
                field.onChange(value === "" ? null : value);
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// Helper for handling required text fields
export function RequiredTextField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input placeholder={placeholder} {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// Helper for handling nullable number fields
export function NullableNumberField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
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
              placeholder={placeholder}
              {...field}
              value={
                (field.value as number | null) !== null
                  ? (field.value as number).toString()
                  : ""
              }
              onChange={(e) => {
                const value = e.target.value;
                const numberValue = value ? parseInt(value, 10) : null;
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
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Combobox
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

// Helper for handling numeric inputs (for amounts, etc.)
export function NumericField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  placeholder,
  step = "0.01",
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

// Helper function to detect changes in a nested field
export function hasNestedFieldChanged<T, F>(
  entity: T,
  entityPath: (e: T) => unknown,
  formValue: F,
): boolean {
  const entityValue = entityPath(entity);
  return JSON.stringify(entityValue) !== JSON.stringify(formValue);
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

// Helper to create an Amount object from form values
export interface AmountValues {
  value: string | number;
  unit: string;
}

export function createAmountObject(values: AmountValues) {
  return {
    value:
      typeof values.value === "string"
        ? parseFloat(values.value)
        : values.value,
    unit: values.unit,
  };
}

// Detect changes in an amount value
export function hasAmountChanged(
  entityAmount: { value: number; unit: string },
  formAmountValue: string | number,
  formAmountUnit: string,
): boolean {
  const numericValue =
    typeof formAmountValue === "string"
      ? parseFloat(formAmountValue)
      : formAmountValue;

  return (
    numericValue !== entityAmount.value || formAmountUnit !== entityAmount.unit
  );
}
