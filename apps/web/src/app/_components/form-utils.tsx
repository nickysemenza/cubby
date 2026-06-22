import type { VariantProps } from "class-variance-authority";
import { lazy, type ReactNode, Suspense } from "react";
import {
  Controller,
  type FieldValues,
  FormProvider,
  type Path,
  type PathValue,
  type UseFormReturn,
} from "react-hook-form";
import { toast } from "sonner";
import { Button, type buttonVariants } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { QuantityInput } from "~/components/ui/quantity-input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useFlag } from "~/lib/flags";
import { cn } from "~/lib/utils";
import { DialogCompatibleCombobox } from "./combobox/combobox-dialog";
import type { ComboboxItem } from "./combobox/combobox-types";

// Build-time guard so the bundler eliminates the @hookform/devtools import (and
// its lodash dependency) from production builds. build:cf pins NODE_ENV=production
// so DEV is false there, but keep the __CF_WORKERS__ check as a belt-and-braces
// guard (same pattern as server/db.ts) — a dev-mode CF build must never ship
// the lodash-importing devtools, which break the Workers server build.
//
// At runtime the devtools are additionally gated behind the `formDevtools`
// developer flag (Settings → Developer), so they stay off by default in dev and
// the user opts in. The build-time constant must remain a separate gate so the
// lazy import is tree-shaken in prod regardless of the flag.
declare const __CF_WORKERS__: boolean | undefined;
const FORM_DEVTOOLS_BUNDLED =
  import.meta.env.DEV &&
  !(typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true);

const DevTool = FORM_DEVTOOLS_BUNDLED
  ? lazy(() =>
      import("@hookform/devtools").then((m) => ({ default: m.DevTool })),
    )
  : () => null;

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

// Helper function to generate submit button text based on mode
export function getSubmitButtonText(mode: "create" | "edit"): string {
  return mode === "create" ? "Create" : "Save";
}

// Active-tense label shown while a submit is in flight, so the pending state
// reads clearly (not just a static label with a spinner).
function getPendingButtonText(text: string): string {
  if (text === "Save") return "Saving…";
  if (text === "Create") return "Creating…";
  return `${text}…`;
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
  stickyFooter = false,
  footerStart,
}: {
  form: UseFormReturn<TFieldValues>;
  onSubmit: (values: TFieldValues) => void;
  error?: string;
  isPending: boolean;
  onCancel?: () => void;
  submitButtonText: string;
  submitButtonVariant?: VariantProps<typeof buttonVariants>["variant"];
  children: ReactNode;
  /** Float the actions in a chunky bar that stays in reach on long forms. */
  stickyFooter?: boolean;
  /** Left slot of the sticky bar (e.g. a live tally). Sticky mode only. */
  footerStart?: ReactNode;
}) {
  // Runtime opt-in via the `formDevtools` developer flag. The hook runs in all
  // builds (Rules of Hooks), but the panel only mounts when the devtools are
  // bundled (dev) AND the user has flipped the flag on in Settings → Developer.
  const formDevtoolsEnabled = useFlag("formDevtools");
  return (
    <FormProvider {...form}>
      {FORM_DEVTOOLS_BUNDLED && formDevtoolsEnabled ? (
        <Suspense>
          <DevTool control={form.control as never} />
        </Suspense>
      ) : null}
      <form
        onSubmit={(e) => {
          // https://github.com/orgs/react-hook-form/discussions/7038#discussioncomment-11376398
          e.stopPropagation();
          e.preventDefault();
          // Pass an invalid handler so failed validation isn't swallowed silently
          // (react-hook-form otherwise no-ops the submit). Custom inputs don't all
          // receive RHF's auto-focus, so scroll the first invalid field into view.
          form.handleSubmit(onSubmit, () => {
            toast.error("Some fields need attention before you can save.");
            requestAnimationFrame(() => {
              document
                .querySelector('[aria-invalid="true"]')
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
            });
          })(e);
        }}
        className="space-y-2"
      >
        {children}

        {error && <div className="text-destructive text-sm">{error}</div>}

        {/* flex-col-reverse: primary submit sits at the bottom (thumb reach)
            on mobile, full-width; reverts to submit-left/cancel-right on sm+.
            Sticky mode floats the actions in a chunky ledger bar that stays in
            reach on long forms (offset above the mobile bottom nav). */}
        <div
          className={cn(
            stickyFooter
              ? "sticky bottom-20 z-20 flex items-center gap-3 rounded-lg border border-[var(--border-chunky)] bg-card px-3 py-2 shadow-[var(--shadow-chunky)] md:bottom-4"
              : "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
          )}
        >
          {stickyFooter && footerStart && (
            <div className="min-w-0 flex-1">{footerStart}</div>
          )}
          <div
            className={cn(
              stickyFooter
                ? "flex shrink-0 flex-row-reverse items-center gap-2"
                : "contents",
            )}
          >
            <Button
              type="submit"
              disabled={isPending}
              variant={submitButtonVariant}
              className={cn(!stickyFooter && "w-full max-sm:h-11 sm:w-auto")}
            >
              {isPending && <Spinner size="sm" />}
              {isPending
                ? getPendingButtonText(submitButtonText)
                : submitButtonText}
            </Button>
            <Button
              type="button"
              variant={stickyFooter ? "ghost" : "outline"}
              onClick={onCancel}
              disabled={isPending}
              className={cn(!stickyFooter && "w-full max-sm:h-11 sm:w-auto")}
            >
              Cancel
            </Button>
          </div>
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
  fraction = false,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  placeholder: string;
  step?: string;
  prefix?: string;
  /**
   * Render the fraction-aware {@link QuantityInput} instead of a raw number
   * input, so "1 1/2" parses/displays correctly. Use for measure amounts; leave
   * off for counts, IDs, and currency (where fraction formatting is wrong).
   */
  fraction?: boolean;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        if (fraction) {
          return (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={name}>{label}</FieldLabel>
              <QuantityInput
                aria-label={label}
                placeholder={placeholder}
                value={(field.value as number | null) ?? null}
                onChange={(value) =>
                  field.onChange(
                    value as PathValue<TFieldValues, Path<TFieldValues>>,
                  )
                }
              />
              {fieldState.error && <FieldError errors={[fieldState.error]} />}
            </Field>
          );
        }

        const inputProps = {
          id: name,
          type: "number" as const,
          step,
          placeholder,
          ...field,
          value: field.value != null ? (field.value as number).toString() : "",
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
  onSelect,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label?: string;
  items: ComboboxItem[];
  onSearchChange: (query: string) => void;
  isLoading?: boolean;
  onCreateNew?: (name: string) => Promise<ComboboxItem>;
  // Fires with the selected item (or null on clear), after the field updates.
  // Lets callers sync a sibling field — e.g. write the ingredient's aliases to
  // the row so the Re-parse drift check sees them.
  onSelect?: (item: ComboboxItem | null) => void;
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
            setValue={(value) => {
              field.onChange(
                value as PathValue<TFieldValues, Path<TFieldValues>>,
              );
              onSelect?.(value);
            }}
            onCreateNew={onCreateNew}
          />
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

// Helper to submit changes or cancel if no changes detected
export function submitOrCancel<T>(
  updates: Record<string, unknown>,
  buildPayload: () => T,
  onEdit: (data: T) => void,
  onCancel?: () => void,
) {
  if (Object.keys(updates).length > 0) {
    onEdit(buildPayload());
  } else {
    onCancel?.();
  }
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
    <div
      className={cn(
        "flex flex-col space-y-2 sm:flex-row sm:space-x-2 sm:space-y-0",
        className,
      )}
    >
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

/**
 * Select field over a **fixed, in-memory option list** (enums, small static
 * sets). Backed by {@link FilterableCombobox} for type-to-filter.
 *
 * Pick the right combobox for the job:
 * - `SelectField` — static options, page-level forms.
 * - {@link ComboboxField} / `ComboboxFieldWithSearch` — async entity search
 *   (ingredient/product/location/recipe) and anything rendered inside a Dialog,
 *   where `DialogCompatibleCombobox` avoids the nested focus-trap conflict.
 */
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
  options: { value: string; label: string; icon?: React.ReactNode }[];
  placeholder?: string;
  nullable?: boolean;
  disabled?: boolean;
  description?: string;
}) {
  // Build items list, prepending "None" option if nullable
  const items = nullable
    ? [{ value: "__none__", label: "None" }, ...options]
    : options;

  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <FilterableCombobox
            items={items}
            value={field.value ?? (nullable ? "__none__" : null)}
            onValueChange={(value) =>
              field.onChange(value === "__none__" ? null : value)
            }
            placeholder={placeholder || `Select ${label.toLowerCase()}`}
            disabled={disabled}
          />
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}
