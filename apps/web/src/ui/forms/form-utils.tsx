import { getErrorMessage } from "@cubby/shared";
import type { VariantProps } from "class-variance-authority";
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Controller,
  type FieldValues,
  type FieldPathByValue,
  type FieldPathValue,
  FormProvider,
  type UseFormReturn,
} from "react-hook-form";
import { toast } from "sonner";

import { FLAGS } from "~/lib/flags";
import { cn } from "~/lib/utils";
import { Stack } from "~/ui/layout";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Button, type buttonVariants } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { QuantityInput } from "~/ui/primitives/quantity-input";
import { Spinner } from "~/ui/primitives/spinner";
import { Textarea } from "~/ui/primitives/textarea";

import { DatePickerInput } from "../date-picker-input";

import "../common/ledger.css";
import { FormFieldGroup } from "./form-field-group";

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
 * The sticky bar's live tally stays in the form when its actions live in an overlay.
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
  id,
  hideActions = false,
  onSubmittingChange,
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
  fieldLayout,
}: {
  form: UseFormReturn<TFieldValues>;
  id?: string;
  hideActions?: boolean;
  /** Includes resolver validation and all awaited completion work. */
  onSubmittingChange?: (pending: boolean) => void;
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
  /** `"ledger"` puts labels in a quiet left column beside their controls
   * (`ledger.css`); dialog forms only. Stacked by default. */
  fieldLayout?: "ledger";
}) {
  // Compile-time opt-in via the `formDevtools` flag. The panel only mounts
  // when the devtools are bundled (dev) AND the flag is on (see flags.ts).
  const formDevtoolsEnabled = FLAGS.formDevtools;

  const localFormId = useId();
  const formId = id ?? localFormId;
  const submitting = useRef(false);
  const [submitError, setSubmitError] = useState<string>();
  const effectiveError = [
    ...(typeof error === "string" ? [error] : (error ?? [])),
    ...(submitError ? [submitError] : []),
  ];
  useSubmitSuccessToast(isPending, effectiveError, successMessage);
  const submitText = isPending
    ? getPendingButtonText(submitButtonText)
    : submitButtonText;

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
          if (submitting.current || isPending) return;
          submitting.current = true;
          onSubmittingChange?.(true);
          setSubmitError(undefined);
          void form
            .handleSubmit(onSubmit, () => {
              toast.error("Some fields need attention before you can save.");
              requestAnimationFrame(() => {
                formElement
                  .querySelector('[aria-invalid="true"]')
                  ?.scrollIntoView({ block: "center", behavior: "auto" });
              });
            })(e)
            .catch((failure: unknown) => {
              setSubmitError(getErrorMessage(failure));
            })
            .finally(() => {
              submitting.current = false;
              onSubmittingChange?.(false);
            });
        }}
      >
        {footerMode === "dialog" ? (
          <div
            data-slot="dialog-form-body"
            data-field-layout={fieldLayout}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-4",
              fieldLayout === "ledger" ? "space-y-2" : "space-y-3",
            )}
          >
            {children}
            <FormStatusBanner error={effectiveError} />
          </div>
        ) : (
          <>
            {children}
            <FormStatusBanner error={effectiveError} />
          </>
        )}

        {hideActions ? (
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

const describedBy = (ids: Array<string | null>) =>
  ids.filter(Boolean).join(" ") || undefined;

/**
 * The one textarea field primitive. `nullable` maps an emptied box to `null`;
 * `description` and `rows` tune the surrounding group and box.
 */
export function TextareaField<TFieldValues extends FieldValues = FieldValues>({
  form,
  name,
  label,
  placeholder,
  description,
  rows = 3,
  nullable = false,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  placeholder?: string;
  description?: ReactNode;
  rows?: number;
  nullable?: boolean;
}) {
  const descriptionId = `${name}-description`;
  const errorId = `${name}-error`;
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={name}
          descriptionId={descriptionId}
          errorId={errorId}
          label={label}
          description={description}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Textarea
            id={name}
            {...field}
            value={field.value ?? ""}
            placeholder={placeholder}
            className="min-h-0 px-2 py-1"
            rows={rows}
            onChange={(event) =>
              field.onChange(
                event.target.value === "" && nullable
                  ? null
                  : event.target.value,
              )
            }
            aria-invalid={fieldState.invalid}
            aria-describedby={describedBy([
              description ? descriptionId : null,
              fieldState.error ? errorId : null,
            ])}
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
  namedClear = false,
  showClearAction = true,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  description?: ReactNode;
  clearable?: boolean;
  clearLabel?: string;
  clearDisabledReason?: string | undefined;
  /** The clear action records a domain state ("Date unknown") worth its own
   * labeled button; a plain clear is the picker's own ×. */
  namedClear?: boolean;
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
            {clearable && showClearAction && namedClear ? (
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
      // SAFETY: this nullable field's unknown value is null; RHF's generic
      // path lookup cannot carry that constraint into its defaultValue type.
      defaultValue={null as FieldPathValue<TFieldValues, typeof name>}
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
      data-slot="side-by-side-fields"
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
  hideLabel,
  description,
  placeholder,
  nullable = false,
  getIcon,
  focusOnMount = false,
  suggestion,
}: {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  label: string;
  hideLabel?: boolean;
  description?: ReactNode;
  placeholder: string;
  nullable?: boolean;
  getIcon?: (value: string | null) => ReactNode;
  /** Focus this field on mount — e.g. a quick-add dialog's name field. */
  focusOnMount?: boolean;
  /** Rendered under the input — an entity field's AI suggestion slot. */
  suggestion?: ReactNode;
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
            hideLabel={hideLabel}
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
            {suggestion}
          </FormFieldGroup>
        );
      }}
    />
  );
}
