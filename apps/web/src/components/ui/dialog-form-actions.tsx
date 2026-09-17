import { useEffect, useRef } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useDialogHeaderActionsRegistration } from "~/components/ui/responsive-dialog";
import { Spinner } from "~/components/ui/spinner";
import { useIsMobile } from "~/hooks/useMobile";

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
 *
 * On phone, inside a `ResponsiveDialog`, this hands its Cancel/Submit to the
 * sheet's 52px header instead (DESIGN.md's edit-dialog vocabulary: a
 * full-height sheet with Cancel/title/submit in the header and no footer) and
 * renders only the error line here. The `form`/`onSubmit` wiring is preserved
 * — the header button carries the same `form` id or `onClick`, and the native
 * `form` attribute submits it regardless of where in the document the button
 * lives.
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
  const isMobile = useIsMobile();
  const registerHeaderActions = useDialogHeaderActionsRegistration();
  const useHeaderActions = isMobile && registerHeaderActions != null;
  const submitText = pending ? "Saving…" : submitLabel;
  const hasOnSubmit = onSubmit != null;

  // Callbacks read through a ref rather than sitting in the effect's
  // dependency array — most callers pass a fresh `onCancel`/`onSubmit`
  // closure every render, and depending on their identity would re-register
  // (and re-render the enclosing ResponsiveDialog) every render, an infinite
  // update loop the first time a caller doesn't memoize them.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    if (!useHeaderActions || !registerHeaderActions) return;
    registerHeaderActions({
      cancel: {
        label: cancelLabel,
        onClick: () => onCancelRef.current(),
        disabled: pending,
      },
      submit: {
        label: submitText,
        type: hasOnSubmit ? "button" : "submit",
        form: hasOnSubmit ? undefined : form,
        onClick: hasOnSubmit ? () => onSubmitRef.current?.() : undefined,
        disabled: pending || submitDisabled,
      },
    });
    return () => registerHeaderActions(null);
  }, [
    useHeaderActions,
    registerHeaderActions,
    cancelLabel,
    pending,
    submitText,
    hasOnSubmit,
    form,
    submitDisabled,
  ]);

  if (useHeaderActions) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : null;
  }

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
          {submitText}
        </Button>
      </Row>
    </Stack>
  );
}
