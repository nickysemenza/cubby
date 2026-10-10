import type { ReactNode } from "react";
import type { FieldError as RHFFieldError } from "react-hook-form";

import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";

/**
 * Standardized labeled-field block: `<Field>` wrapper + optional `<FieldLabel>`,
 * the input `children`, an optional muted description, and the field error.
 *
 * This is the single source of truth for the repeated
 * `<Field data-invalid>… <FieldLabel>… {error && <FieldError/>}` shape used by
 * the field helpers in `form-utils.tsx`. Render your control as `children` and
 * let this own the surrounding chrome so labels, descriptions, invalid styling,
 * and error rendering stay consistent across every form.
 */
export function FormFieldGroup({
  htmlFor,
  label,
  hideLabel,
  description,
  error,
  invalid,
  descriptionId,
  errorId,
  children,
}: {
  /** `id` of the control, wired to the label via `htmlFor`. */
  htmlFor?: string;
  /** Field label. Omit for an unlabeled control (e.g. a bare combobox). */
  label?: string;
  /** Preserve the accessible name when a surrounding grid supplies visible headings. */
  hideLabel?: boolean;
  /** Muted helper text rendered between the control and the error. */
  description?: ReactNode;
  /** The field's error (from RHF `fieldState.error`), rendered if present. */
  error?: RHFFieldError;
  /** Drives the `data-invalid` / `aria` invalid styling on the group. */
  invalid?: boolean;
  descriptionId?: string;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <Field data-invalid={invalid}>
      {label && (
        <FieldLabel
          htmlFor={htmlFor}
          className={hideLabel ? "sr-only" : undefined}
        >
          {label}
        </FieldLabel>
      )}
      {children}
      {description && (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {error && <FieldError id={errorId} errors={[error]} />}
    </Field>
  );
}
