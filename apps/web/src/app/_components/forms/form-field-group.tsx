import type { ReactNode } from "react";
import type { FieldError as RHFFieldError } from "react-hook-form";

import { Field, FieldError, FieldLabel } from "~/components/ui/field";

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
  description,
  error,
  invalid,
  children,
}: {
  /** `id` of the control, wired to the label via `htmlFor`. */
  htmlFor?: string;
  /** Field label. Omit for an unlabeled control (e.g. a bare combobox). */
  label?: string;
  /** Muted helper text rendered between the control and the error. */
  description?: ReactNode;
  /** The field's error (from RHF `fieldState.error`), rendered if present. */
  error?: RHFFieldError;
  /** Drives the `data-invalid` / `aria` invalid styling on the group. */
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <Field data-invalid={invalid}>
      {label && <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>}
      {children}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {error && <FieldError errors={[error]} />}
    </Field>
  );
}
