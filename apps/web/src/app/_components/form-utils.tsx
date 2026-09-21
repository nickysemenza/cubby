import type { VariantProps } from "class-variance-authority";
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  Controller,
  type FieldValues,
  type FieldPathByValue,
  FormProvider,
  type Path,
  type UseFormReturn,
} from "react-hook-form";
import { toast } from "sonner";

import { AutoSuggestSlot } from "~/app/_components/ai/auto-suggest-slot";
import { Stack } from "~/components/layout";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button, type buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { QuantityInput } from "~/components/ui/quantity-input";
import { useDialogHeaderActionsRegistration } from "~/components/ui/responsive-dialog";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useIsMobile } from "~/hooks/useMobile";
import { FLAGS } from "~/lib/flags";
import { cn } from "~/lib/utils";

import type { ComboboxItem, PickerEntity } from "./combobox/combobox-types";
import { EntityPicker } from "./combobox/entity-picker";
import { StaticPicker } from "./combobox/static-picker";
import { DatePickerInput } from "./date-picker-input";
import { FormFieldGroup } from "./forms/form-field-group";

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
const readCloudflareWorkersFlag = (): boolean | undefined => {
  try {
    return __CF_WORKERS__;
  } catch {
    return undefined;
  }
};
const FORM_DEVTOOLS_BUNDLED =
  import.meta.env.DEV && readCloudflareWorkersFlag() !== true;

const DevTool = FORM_DEVTOOLS_BUNDLED
  ? lazy(() =>
      import("@hookform/devtools").then((m) => ({ default: m.DevTool })),
    )
  : () => null;

function devToolControl<TFieldValues extends FieldValues>(
  control: UseFormReturn<TFieldValues>["control"],
) {
  // SAFETY: @hookform/devtools accepts the same control at runtime but
  // publishes an incompatible private generic surface.
  return control as never;
}

// Base props shared by all forms
interface BaseFormProps {
  isPending: boolean;
  error?: string | readonly string[];
  onCancel?: () => void;
}

// Generic create mode props
interface CreateModeProps<TCreateData> extends BaseFormProps {
  mode: "create";
  onCreate: (data: TCreateData) => void;
  onEdit?: never;
  // The entity property will be specified in the consuming component
}

// Generic edit mode props
interface EditModeProps<TEditData, TEntity> extends BaseFormProps {
  mode: "edit";
  onEdit: (data: TEditData) => void;
  onCreate?: never;
  entity: TEntity;
}

/**
 * Shared create/edit prop union for a rich entity form built on
 * `useEntityFormController` — replaces each form's hand-rolled
 * `Create*FormProps`/`Edit*FormProps` pair. Keeps `EditModeProps`'s `entity`
 * field name (rather than e.g. `record`) so these forms stay assignable to
 * `ComponentType<EditModeProps<TEditData, TEntity>>`, the shape a detail
 * edit surface (`ProductEditDialog`) invokes the form with.
 */
export type EntityFormProps<
  TCreateData,
  TEditData = TCreateData,
  TEntity = TCreateData,
> = CreateModeProps<TCreateData> | EditModeProps<TEditData, TEntity>;

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

/**
 * Submission-level feedback banner for a form — distinct from per-field
 * `FieldError`. Surfaces a server/mutation error (the `error` flows up from the
 * entity mutation hooks) in the same `destructive` Alert chrome used across the
 * app. A refusal can name several reasons at once — a lifecycle blocker per
 * edge — so a list is rendered in full rather than reduced to its first line.
 * Not exported standalone until a non-wrapper consumer needs it (keeps the
 * lint/knip unused-export gate clean).
 */
function FormStatusBanner({ error }: { error?: string | readonly string[] }) {
  const lines = isFormErrorMessage(error) ? [error] : (error ?? []);
  if (lines.length === 0) return null;
  return (
    <Alert variant="destructive" data-slot="form-status-banner">
      <AlertTitle>Couldn’t save</AlertTitle>
      <AlertDescription>
        {lines.length === 1 ? (
          lines[0]
        ) : (
          <ul className="space-y-1">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

type FormError = string | readonly string[] | undefined;
const isFormErrorMessage = (error: FormError): error is string =>
  typeof error === "string";

/**
 * Fire a success toast on the pending → settled transition (when no error
 * landed). Kept generic so any `FormWrapper`-based form can opt in by passing
 * `successMessage`; the edge-trigger on `isPending` avoids re-toasting on
 * unrelated re-renders.
 */
function useSubmitSuccessToast(
  isPending: boolean,
  error: string | readonly string[] | undefined,
  successMessage: string | undefined,
) {
  const wasPending = useRef(false);
  const failed = isFormErrorMessage(error) ? error.length > 0 : !!error?.length;
  useEffect(() => {
    if (wasPending.current && !isPending && !failed && successMessage) {
      toast.success(successMessage);
    }
    wasPending.current = isPending;
  }, [isPending, failed, successMessage]);
}

const FORM_FOOTER_CLASS = {
  sticky:
    "sticky bottom-[calc(var(--app-chrome-bottom)+0.5rem)] z-20 flex items-center gap-2 border border-[var(--border)] bg-card px-2 py-2 md:bottom-4",
  dialog:
    "flex shrink-0 flex-col-reverse gap-2 border-t bg-popover px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-3",
  inline: "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
} as const;

function formFooterClassName(
  stickyFooter: boolean,
  footerMode: "inline" | "dialog",
) {
  return stickyFooter
    ? FORM_FOOTER_CLASS.sticky
    : FORM_FOOTER_CLASS[footerMode];
}

/**
 * Phone edit-dialog vocabulary (DESIGN.md): a dialog-mode form on phone hands
 * its Cancel/Submit to the enclosing ResponsiveDialog's 52px sheet header
 * instead of rendering its own footer row. `formId` lets the header's submit
 * button target this `<form>` via the native `form` attribute even though it
 * renders outside this subtree. Returns whether the header owns the actions.
 */
function useDialogHeaderFormActions({
  formId,
  submitText,
  isPending,
  onCancel,
}: {
  formId: string;
  submitText: string;
  isPending: boolean;
  onCancel: (() => void) | undefined;
}): boolean {
  const isMobile = useIsMobile();
  const registerHeaderActions = useDialogHeaderActionsRegistration();
  const useHeaderActions = isMobile && registerHeaderActions != null;

  // `onCancel` reads through a ref rather than sitting in the effect's
  // dependency array — callers routinely pass a fresh closure every render
  // (e.g. `onCancel={close}` where `close` is a plain function literal), and
  // depending on its identity would re-register — and re-render the
  // enclosing ResponsiveDialog — every render, an infinite update loop.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!useHeaderActions || !registerHeaderActions) return;
    registerHeaderActions({
      cancel: {
        label: "Cancel",
        onClick: () => onCancelRef.current?.(),
        disabled: isPending,
      },
      submit: {
        label: submitText,
        type: "submit",
        form: formId,
        disabled: isPending,
      },
    });
    return () => registerHeaderActions(null);
  }, [useHeaderActions, registerHeaderActions, isPending, submitText, formId]);

  return useHeaderActions;
}

/**
 * The sticky bar's live tally (a running total, a count) survives the move to
 * sheet-header actions as a plain line at the end of the form.
 */
function FormTallyLine({
  stickyFooter,
  footerStart,
}: {
  stickyFooter: boolean;
  footerStart: ReactNode;
}) {
  if (!stickyFooter || !footerStart) return null;
  return <div className="text-xs text-muted-foreground">{footerStart}</div>;
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
  footerMode = "inline",
  footerStart,
  successMessage,
}: {
  form: UseFormReturn<TFieldValues>;
  onSubmit: (values: TFieldValues) => void;
  error?: string | readonly string[];
  isPending: boolean;
  onCancel?: () => void;
  submitButtonText: string;
  submitButtonVariant?: VariantProps<typeof buttonVariants>["variant"];
  children: ReactNode;
  /** Float the actions in a chunky bar that stays in reach on long forms. */
  stickyFooter?: boolean;
  /** Dialog layout: fields scroll while actions remain fixed in the dialog shell. */
  footerMode?: "inline" | "dialog";
  /** Left slot of the sticky bar (e.g. a live tally). Sticky mode only. */
  footerStart?: ReactNode;
  /**
   * Toast shown once a submit settles successfully (pending → done, no error).
   * Omit to keep the form silent on success (e.g. when the caller toasts).
   */
  successMessage?: string;
}) {
  // Compile-time opt-in via the `formDevtools` flag. The panel only mounts
  // when the devtools are bundled (dev) AND the flag is on (see flags.ts).
  const formDevtoolsEnabled = FLAGS.formDevtools;
  useSubmitSuccessToast(isPending, error, successMessage);

  const formId = useId();
  const submitText = isPending
    ? getPendingButtonText(submitButtonText)
    : submitButtonText;
  // Any form inside a phone ResponsiveDialog hands its actions to the sheet
  // header: dialog-mode and sticky-bar forms alike (the product form opens
  // in a dialog with its sticky bar). The registration context only exists
  // inside a ResponsiveDialog, so page forms are unaffected.
  const useHeaderActions = useDialogHeaderFormActions({
    formId,
    submitText,
    isPending,
    onCancel,
  });

  return (
    <FormProvider {...form}>
      {FORM_DEVTOOLS_BUNDLED && formDevtoolsEnabled ? (
        <Suspense>
          <DevTool control={devToolControl(form.control)} />
        </Suspense>
      ) : null}
      <Stack
        as="form"
        id={formId}
        gap={footerMode === "dialog" ? null : "sm"}
        className={cn(footerMode === "dialog" && "min-h-0 flex-1")}
        onSubmit={(e: React.FormEvent<HTMLElement>) => {
          // https://github.com/orgs/react-hook-form/discussions/7038#discussioncomment-11376398
          e.stopPropagation();
          e.preventDefault();
          // Pass an invalid handler so failed validation isn't swallowed silently
          // (react-hook-form otherwise no-ops the submit). Custom inputs don't all
          // receive RHF's auto-focus, so scroll the first invalid field into view.
          const formElement = e.currentTarget;
          form.handleSubmit(onSubmit, () => {
            toast.error("Some fields need attention before you can save.");
            requestAnimationFrame(() => {
              formElement
                .querySelector('[aria-invalid="true"]')
                ?.scrollIntoView({ block: "center", behavior: "auto" });
            });
          })(e);
        }}
      >
        {footerMode === "dialog" ? (
          <div
            data-slot="dialog-form-body"
            className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain px-4 pt-1 pb-4"
          >
            {children}
            <FormStatusBanner error={error} />
          </div>
        ) : (
          <>
            {children}
            <FormStatusBanner error={error} />
          </>
        )}

        {/* flex-col-reverse: primary submit sits at the bottom (thumb reach)
            on mobile, full-width; reverts to submit-left/cancel-right on sm+.
            Sticky mode floats the actions in a chunky ledger bar that stays in
            reach on long forms (offset above the mobile bottom nav). On phone,
            dialog mode hands these buttons to the ResponsiveDialog's sheet
            header instead (see `useHeaderActions` above) and renders nothing
            here — the phone edit dialog has no footer. */}
        {useHeaderActions ? (
          <FormTallyLine
            stickyFooter={stickyFooter}
            footerStart={footerStart}
          />
        ) : (
          <div
            data-slot={
              footerMode === "dialog" ? "dialog-form-footer" : "form-footer"
            }
            className={formFooterClassName(stickyFooter, footerMode)}
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
                {submitText}
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
        )}
      </Stack>
    </FormProvider>
  );
}

// Nullable textarea — empty string coerces to null (same contract as
// UnifiedTextField's nullable mode).
export function NullableTextareaField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  label,
  placeholder,
  rows = 4,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  placeholder: string;
  rows?: number;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={name}
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Textarea
            id={name}
            placeholder={placeholder}
            {...field}
            value={field.value ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              field.onChange(v === "" ? null : v);
            }}
            className="min-h-0 px-2 py-1"
            rows={rows}
            aria-invalid={fieldState.invalid}
          />
        </FormFieldGroup>
      )}
    />
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
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  placeholder: string;
  rows?: number;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={name}
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Textarea
            id={name}
            placeholder={placeholder}
            {...field}
            className="min-h-0 px-2 py-1"
            rows={rows}
            aria-invalid={fieldState.invalid}
          />
        </FormFieldGroup>
      )}
    />
  );
}

/**
 * A plain "YYYY-MM-DD" calendar-date field (task due date, expense date,
 * project start/end date) — backed by the shared `DatePickerInput`, which
 * speaks the same "YYYY-MM-DD" string end to end.
 */
export function PlainDateField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  description,
  clearable = true,
  clearLabel = "Clear date",
  clearDisabledReason,
  showClearAction = true,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  description?: ReactNode;
  clearable?: boolean;
  clearLabel?: string;
  clearDisabledReason?: string | undefined;
  showClearAction?: boolean;
}) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={controlId}
          label={label}
          description={description}
          descriptionId={descriptionId}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Stack gap="xs">
            <DatePickerInput
              id={controlId}
              name={name}
              value={field.value ?? null}
              onChange={(v) => field.onChange(v)}
              onBlur={field.onBlur}
              clearable={clearable}
              required={!clearable}
              aria-label={label}
              aria-invalid={fieldState.invalid}
              aria-describedby={description ? descriptionId : undefined}
            />
            {clearable && showClearAction ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => field.onChange(null)}
              >
                {clearLabel}
              </Button>
            ) : showClearAction && clearDisabledReason ? (
              <span className="text-xs text-muted-foreground">
                {clearDisabledReason}
              </span>
            ) : null}
          </Stack>
        </FormFieldGroup>
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
  name: FieldPathByValue<TFieldValues, number | null | undefined>;
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
            <FormFieldGroup
              htmlFor={name}
              label={label}
              invalid={fieldState.invalid}
              error={fieldState.error}
            >
              <QuantityInput
                id={name}
                aria-label={label}
                placeholder={placeholder}
                value={field.value ?? null}
                onChange={(value) => field.onChange(value)}
              />
            </FormFieldGroup>
          );
        }

        const inputProps = {
          id: name,
          type: "number" as const,
          // iOS shows its numeric keypad only when inputMode says so — plain
          // type="number" alone still surfaces the full keyboard on Safari.
          inputMode: "decimal" as const,
          step,
          placeholder,
          ...field,
          value: field.value != null ? field.value.toString() : "",
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const value = e.target.value;
            const numberValue = value ? parseFloat(value) : null;
            field.onChange(numberValue);
          },
          "aria-invalid": fieldState.invalid,
        };

        return (
          <FormFieldGroup
            htmlFor={name}
            label={label}
            invalid={fieldState.invalid}
            error={fieldState.error}
          >
            {prefix ? (
              <div className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                  {prefix}
                </span>
                <Input
                  {...inputProps}
                  className="pl-7" /* tight: clears absolute prefix */
                />
              </div>
            ) : (
              <Input {...inputProps} />
            )}
          </FormFieldGroup>
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
  onOpenChange,
  entity,
  clearable = true,
  disabledItemReasons,
  suggestField,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>;
  label?: string;
  items: ComboboxItem[];
  onSearchChange: (query: string) => void;
  isLoading?: boolean;
  onCreateNew?: (name: string) => Promise<ComboboxItem>;
  // Fires with the selected item (or null on clear), after the field updates.
  // Lets callers sync a sibling field — e.g. write the ingredient's aliases to
  // the row so the Re-parse drift check sees them.
  onSelect?: (item: ComboboxItem | null) => void;
  // Forwarded to the combobox so an async-search wrapper can defer its options
  // query until the dropdown opens.
  onOpenChange?: (open: boolean) => void;
  entity: PickerEntity;
  clearable?: boolean;
  disabledItemReasons?: Readonly<Record<string, string>>;
  /** The manifest target key this field suggests (e.g. `"projectId"`). The
   * field's value is the whole `ComboboxItem`, so an auto-fill writes one
   * directly — no separate `seedItem` lookup needed the way `EntityValueField`
   * (id-valued) requires it. */
  suggestField?: string;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={name}
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <EntityPicker
            inputId={name}
            inputRef={field.ref}
            entity={entity}
            label={label ?? "item"}
            items={items.map((item) => {
              const disabledReason = disabledItemReasons?.[item.id];
              return disabledReason
                ? {
                    ...item,
                    presentation: {
                      ...item.presentation,
                      group: {
                        id: "unavailable",
                        label: "Unavailable",
                        order: 99,
                      },
                      disabledReason,
                    },
                  }
                : item;
            })}
            onSearchChange={onSearchChange}
            isLoading={isLoading}
            value={field.value ?? null}
            setValue={(value) => {
              field.onBlur();
              field.onChange(value);
              onSelect?.(value);
            }}
            onCreateNew={onCreateNew}
            onOpenChange={(open) => {
              if (!open) field.onBlur();
              onOpenChange?.(open);
            }}
            clearable={clearable}
          />
          {suggestField && (
            <AutoSuggestSlot
              form={form}
              name={name}
              field={suggestField}
              valueKind="item"
            />
          )}
        </FormFieldGroup>
      )}
    />
  );
}

// Generic function to build an update object based on changed fields
export function buildUpdateObject<
  T extends object,
  K extends keyof T,
  F extends Pick<T, K>,
>(entity: T, formValues: F, fields: readonly K[]): Partial<T> {
  const updates: Partial<T> = {};

  fields.forEach((field) => {
    const entityValue = entity[field];
    const formValue = formValues[field];
    if (JSON.stringify(entityValue) !== JSON.stringify(formValue)) {
      Object.assign(updates, { [field]: formValue });
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
  parseId: (value: string) => TId,
): TId | null | undefined {
  if (entityId === null && !comboboxItem) {
    return undefined; // No change if both are null/empty
  }
  if (entityId === null && comboboxItem) {
    return parseId(comboboxItem.id); // Set new ID if entity was null
  }
  if (entityId !== null && !comboboxItem) {
    return null; // Set to null if removing association
  }
  if (comboboxItem && comboboxItem.id !== entityId) {
    return parseId(comboboxItem.id); // Change ID if different
  }
  return undefined; // No change
}

// Helper to build a common form layout with two fields side by side
export function SideBySideFields({
  children,
  className,
  narrowFirst = false,
}: {
  children: ReactNode;
  className?: string;
  /**
   * Pin the first field to a tight fixed width (for short numeric inputs like a
   * quantity) and let the second field take the remaining space, instead of the
   * default 50/50 split. Used by the compact qty/unit rows.
   */
  narrowFirst?: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-col space-y-2 sm:flex-row sm:space-y-0 sm:space-x-2",
        className,
      )}
    >
      <div className={narrowFirst ? "w-16 shrink-0" : "flex-1"}>
        {Array.isArray(children) ? children[0] : children}
      </div>
      <div className="min-w-0 flex-1">
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
  description,
  placeholder,
  nullable = false,
  getIcon,
  focusOnMount = false,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  description?: ReactNode;
  placeholder: string;
  nullable?: boolean;
  getIcon?: (value: string | null) => ReactNode;
  /** Focus this field on mount — e.g. a quick-add dialog's name field. */
  focusOnMount?: boolean;
}) {
  const descriptionId = useId();
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const value = field.value ?? "";
        const icon = getIcon ? getIcon(field.value ?? null) : null;
        return (
          <FormFieldGroup
            htmlFor={name}
            label={label}
            description={description}
            descriptionId={descriptionId}
            invalid={fieldState.invalid}
            error={fieldState.error}
          >
            <div className="relative">
              {/* oxlint-disable jsx-a11y/no-autofocus -- Quick-add dialogs intentionally focus their primary field when requested. */}
              <Input
                id={name}
                placeholder={placeholder}
                {...field}
                value={value}
                onChange={(e) => {
                  const v = e.target.value;
                  field.onChange(nullable ? (v === "" ? null : v) : v);
                }}
                className={
                  icon ? "pr-10" /* tight: clears absolute icon */ : undefined
                }
                aria-invalid={fieldState.invalid}
                aria-describedby={description ? descriptionId : undefined}
                autoFocus={focusOnMount}
              />
              {/* oxlint-enable jsx-a11y/no-autofocus */}
              {icon && (
                <span className="absolute inset-y-0 right-3 flex items-center">
                  {icon}
                </span>
              )}
            </div>
          </FormFieldGroup>
        );
      }}
    />
  );
}

/**
 * Select field over a **fixed, in-memory option list** (enums, small static
 * sets). Backed by the shared Base UI picker shell for type-to-filter.
 *
 * Pick the right combobox for the job:
 * - `SelectField` — static options, page-level forms.
 * - {@link ComboboxField} / `ComboboxFieldWithSearch` — async entity search
 *   (ingredient/product/location/recipe) and anything rendered inside a Dialog,
 *   through the shared Base UI entity picker.
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
  suggestField,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  label: string;
  options: readonly {
    value: string;
    label: string;
    icon?: React.ReactNode;
    color?: string;
  }[];
  placeholder?: string;
  nullable?: boolean;
  disabled?: boolean;
  description?: ReactNode;
  /** The manifest target key this field suggests (e.g. `"trade"`) — mounts an
   * `AutoSuggestSlot` under the picker. Omit for a field with no
   * `control.suggest`. */
  suggestField?: string;
}) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  // Build items list, prepending "None" option if nullable
  const items = nullable
    ? [{ value: "__none__", label: "None" }, ...options]
    : options;

  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={controlId}
          label={label}
          description={description}
          descriptionId={descriptionId}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <StaticPicker
            inputId={controlId}
            inputRef={field.ref}
            items={items}
            value={field.value ?? (nullable ? "__none__" : null)}
            onOpenChange={(open) => {
              if (!open) field.onBlur();
            }}
            onValueChange={(value) => {
              field.onBlur();
              field.onChange(value === "__none__" ? null : value);
            }}
            placeholder={placeholder || `Select ${label.toLowerCase()}`}
            label={label}
            aria-describedby={description ? descriptionId : undefined}
            disabled={disabled}
          />
          {suggestField && (
            <AutoSuggestSlot form={form} name={name} field={suggestField} />
          )}
        </FormFieldGroup>
      )}
    />
  );
}
