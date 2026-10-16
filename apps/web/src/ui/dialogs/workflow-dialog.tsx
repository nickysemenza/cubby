import type { ReactNode } from "react";

import { Stack } from "~/ui/layout";
import { DialogFormActions } from "~/ui/primitives/dialog-form-actions";
import { ResponsiveDialog } from "~/ui/primitives/responsive-dialog";

interface WorkflowDialogAction {
  label: string;
  /** Replaces `label` while `pending`. */
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * The shared shell for hand-built multi-step workflow dialogs (split, link,
 * receive, enrich, connect): responsive title/header, caller-owned body, optional summary/error, and
 * Cancel + primary actions. The shared shell promotes actions into the phone
 * header; summary and diagnostics stay in the scrollable body.
 * Omit `primary` for a dialog that has no footer action.
 */
export function WorkflowDialog({
  open,
  onOpenChange,
  size = "md",
  title,
  description,
  trigger,
  summary,
  error,
  primary,
  onCancel,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: "sm" | "md" | "lg" | "xl" | "2xl";
  title: ReactNode;
  description: ReactNode;
  /** A `DialogTrigger` rendered beside the content. */
  trigger?: ReactNode;
  summary?: ReactNode;
  /** A raw mutation error, shown above the footer. */
  error?: string | null;
  primary?: WorkflowDialogAction;
  /** Defaults to closing the dialog. */
  onCancel?: () => void;
  children?: ReactNode;
}) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      size={size}
      title={title}
      description={description}
      trigger={trigger}
      footer={
        primary ? (
          <DialogFormActions
            onCancel={onCancel ?? (() => onOpenChange(false))}
            submitLabel={primary.label}
            pendingLabel={primary.pendingLabel ?? primary.label}
            pending={primary.pending}
            submitDisabled={primary.disabled}
            onSubmit={primary.onClick}
          />
        ) : undefined
      }
    >
      <Stack gap="md">
        {primary ? (
          <p className="text-sm text-muted-foreground md:hidden">
            {description}
          </p>
        ) : null}
        {children}
        {summary ? (
          <div className="text-xs text-muted-foreground">{summary}</div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </Stack>
    </ResponsiveDialog>
  );
}
