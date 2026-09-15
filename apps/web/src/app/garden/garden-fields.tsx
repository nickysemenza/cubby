import { useId, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Stack } from "~/components/layout";
import {
  DialogFormActions,
  type DialogFormActionsProps,
} from "~/components/ui/dialog-form-actions";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

import { gardenStrings } from "./garden-strings";

export function GardenField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date";
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Stack gap="sm">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
      />
    </Stack>
  );
}

export function GardenNotes({
  value,
  onChange,
  label = gardenStrings.common.notesField,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Stack gap="sm">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Stack>
  );
}

/**
 * Every garden dialog opens one leaf form (`EntryForm`, `PlantingForm`,
 * `PlantingActionForm`, `GardenLocationForm`, plus two inline ones in
 * `garden-home.tsx`/`location-history.tsx`) as `ResponsiveDialog`'s
 * `children` — the scrollable body. Only one such dialog is ever
 * interactable at a time (the underlying modal traps focus), so a single
 * fixed pair of ids is enough to wire the two sides together without
 * threading a form id down through every container.
 */
export const GARDEN_DIALOG_FORM_ID = "garden-dialog-form";
const GARDEN_DIALOG_FOOTER_ID = "garden-dialog-footer";

/**
 * Marker each garden dialog container renders as `ResponsiveDialog`'s
 * `footer` — outside the scroll region, so it stays reachable on phone.
 * `GardenFormActions` portals its Cancel/Save into this node.
 */
export function GardenDialogFooterSlot() {
  return <div id={GARDEN_DIALOG_FOOTER_ID} />;
}

/**
 * Thin wrapper over `DialogFormActions`: garden forms render this as the
 * last child of their `<form id={GARDEN_DIALOG_FORM_ID}>`, inside
 * `ResponsiveDialog`'s scrollable body, but the actions must land in the
 * dialog's `footer` slot to stay reachable on phone. Portals into the
 * sibling `GardenDialogFooterSlot` when one is mounted (every real garden
 * dialog renders one); the submit button targets the form by id since a
 * portal moves it out of the form's DOM subtree.
 *
 * Falls back to rendering inline when no footer slot is present — e.g. a
 * form under test in isolation, without a surrounding dialog — so existing
 * standalone renders keep working unchanged.
 */
export function GardenFormActions({
  pending,
  error,
  onCancel,
  label = gardenStrings.common.saveLabel,
  disabled = false,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  label?: string;
  /** Disables the submit button independent of `pending` — e.g. required fields not yet chosen. */
  disabled?: boolean;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTarget(document.getElementById(GARDEN_DIALOG_FOOTER_ID));
  }, []);
  const props: DialogFormActionsProps = {
    pending,
    error,
    onCancel,
    submitLabel: label,
    submitDisabled: disabled,
    form: target ? GARDEN_DIALOG_FORM_ID : undefined,
  };
  const actions = <DialogFormActions {...props} />;
  return target ? createPortal(actions, target) : actions;
}
