import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

export interface DialogFormActionsProps {
  onCancel: () => void;
  submitLabel: string;
  pending?: boolean;
  error?: string | null;
  submitDisabled?: boolean;
  /**
   * Associates the submit button with a `<form id>` living in the dialog
   * body via the native `form` attribute — required whenever the body owns a
   * real `<form onSubmit>`, since this component always renders in
   * `ResponsiveDialog`'s `footer` slot, a DOM sibling of that body rather
   * than a descendant of the form.
   */
  form?: string;
  /**
   * Direct submit handler for dialogs with no native `<form>` element (a
   * plain "commit" callback, e.g. triggering a mutation straight from the
   * button). Provide exactly one of `form` or `onSubmit`.
   */
  onSubmit?: () => void;
  cancelLabel?: string;
}

/**
 * Cancel + primary submit for a `ResponsiveDialog`'s `footer` slot, which
 * stays visible above the fold (and above the iOS keyboard) instead of
 * scrolling away with the body on phone. Buttons default to the 44px phone
 * interaction floor via `Button`'s own `mobileSize="touch"` default, shrinking
 * to the compact desktop height at the `md` breakpoint per DESIGN.md.
 */
export function DialogFormActions({
  onCancel,
  submitLabel,
  pending = false,
  error = null,
  submitDisabled = false,
  form,
  onSubmit,
  cancelLabel = "Cancel",
}: DialogFormActionsProps) {
  return (
    <Stack gap="md">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Row gap="sm" justify="end">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          {cancelLabel}
        </Button>
        <Button
          type={onSubmit ? "button" : "submit"}
          form={form}
          onClick={onSubmit}
          disabled={pending || submitDisabled}
        >
          {pending && <Spinner size="sm" />}
          {pending ? "Saving…" : submitLabel}
        </Button>
      </Row>
    </Stack>
  );
}
