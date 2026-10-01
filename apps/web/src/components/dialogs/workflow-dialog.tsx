import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { StatusText } from "~/components/ui/status-text";

export interface WorkflowDialogAction {
  label: string;
  /** Replaces `label` while `pending`. */
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * The shared shell for hand-built multi-step workflow dialogs (split, link,
 * receive, enrich, connect): title/description header, the body, an optional
 * error line, then a Cancel + primary footer with an optional left-aligned
 * `summary` (e.g. "3 selected"). The body and its state stay with the caller.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {error ? <StatusText tone="destructive">{error}</StatusText> : null}
        {primary ? (
          <DialogFooter>
            {summary}
            <Button
              type="button"
              variant="outline"
              onClick={onCancel ?? (() => onOpenChange(false))}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={primary.disabled || primary.pending}
              onClick={primary.onClick}
            >
              {primary.pending && primary.pendingLabel
                ? primary.pendingLabel
                : primary.label}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
