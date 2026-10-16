import { getErrorMessage } from "@cubby/shared";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { SheetContent } from "~/ui/primitives/sheet";
import { Spinner } from "~/ui/primitives/spinner";

type OverlayAction = {
  label: string;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
} &
  /** Native submission preserves Enter, browser validation and form ownership. */
  (
    | { form: string; onClick?: never }
    | { form?: never; onClick: () => void | Promise<void> }
  );

/** Ordinary modal and workspace panel presentation. The owner supplies actions
 * directly; a child form never registers or relocates its footer through effects. */
export function Overlay({
  open,
  onOpenChange,
  title,
  description,
  size = "sm",
  placement = "dialog",
  trigger,
  primary,
  pending = false,
  onCancel,
  cancelLabel,
  summary,
  error,
  footer,
  bodyMode = "scroll",
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  size?: ComponentProps<typeof DialogContent>["size"];
  placement?: "dialog" | "panel";
  trigger?: ReactNode;
  primary?: OverlayAction;
  /** Whole-body writes without a primary button also block user dismissal. */
  pending?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
  summary?: ReactNode;
  error?: ReactNode;
  /** Auxiliary content for read-only or independent-row surfaces. */
  footer?: ReactNode;
  bodyMode?: "scroll" | "form";
  className?: string;
  children?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const runningRef = useRef(false);
  useEffect(() => {
    if (!open) setActionError(null);
  }, [open]);
  const diagnostic = actionError ?? error;
  const busy = pending || primary?.pending === true || running;
  const blocked = () => busy || runningRef.current;
  const cancel = () => {
    if (blocked()) return;
    if (onCancel) onCancel();
    else onOpenChange(false);
  };
  const run = async () => {
    if (blocked() || primary?.disabled) return;
    runningRef.current = true;
    setRunning(true);
    setActionError(null);
    try {
      await primary?.onClick?.();
    } catch (failure) {
      setActionError(getErrorMessage(failure));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  const phoneActions = isMobile && primary != null;
  const submitLabel = busy
    ? (primary?.pendingLabel ?? "Saving…")
    : primary?.label;
  const submitProps = {
    type: primary?.form ? ("submit" as const) : ("button" as const),
    form: primary?.form,
    onClick: primary?.form ? undefined : run,
    disabled: busy || primary?.disabled,
  };
  const Content =
    isMobile || placement === "panel" ? SheetContent : DialogContent;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && blocked()) return;
        if (next) setActionError(null);
        onOpenChange(next);
      }}
    >
      {trigger}
      <Content
        {...(isMobile || placement === "panel"
          ? { side: isMobile ? ("bottom" as const) : ("right" as const) }
          : { size })}
        showCloseButton={!phoneActions}
        closeDisabled={busy}
        aria-busy={busy || undefined}
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          isMobile &&
            "data-[side=bottom]:overflow-hidden data-[side=bottom]:pb-0",
          phoneActions &&
            "data-[side=bottom]:h-[var(--app-viewport-height,100dvh)] data-[side=bottom]:rounded-t-none data-[side=bottom]:border-t-0",
          placement === "panel" && "max-h-[90dvh] md:max-h-none",
          className,
        )}
      >
        {phoneActions ? (
          <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b px-3">
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="min-h-11 shrink-0 text-sm text-primary disabled:opacity-50"
            >
              {cancelLabel ?? "Cancel"}
            </button>
            <DialogTitle className="min-w-0 flex-1 truncate text-center text-base font-bold tracking-[-0.01em]">
              {title}
            </DialogTitle>
            <button
              {...submitProps}
              className="min-h-11 shrink-0 text-sm font-semibold text-primary disabled:opacity-50"
            >
              {submitLabel}
            </button>
          </div>
        ) : (
          <header className="shrink-0 space-y-1 border-b bg-muted/40 py-3 pr-12 pl-4">
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription>{description}</DialogDescription>
            )}
          </header>
        )}
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1",
            bodyMode === "form"
              ? "flex flex-col"
              : "space-y-3 overflow-y-auto overscroll-contain p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]",
          )}
        >
          {phoneActions && description && (
            <DialogDescription className="px-4 pt-3">
              {description}
            </DialogDescription>
          )}
          {children}
          {summary && (
            <div className="px-4 py-2 text-xs text-muted-foreground">
              {summary}
            </div>
          )}
          {diagnostic && (
            <div
              role="alert"
              className="mx-4 my-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-xs break-words text-destructive"
            >
              {diagnostic}
            </div>
          )}
        </div>
        {((primary && !phoneActions) || (!primary && cancelLabel)) && (
          <div
            data-slot="overlay-actions"
            className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3"
          >
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              disabled={busy}
            >
              {cancelLabel ?? "Cancel"}
            </Button>
            {primary && (
              <Button {...submitProps} variant={primary.variant}>
                {busy && <Spinner size="sm" />}
                {submitLabel}
              </Button>
            )}
          </div>
        )}
        {footer && (
          <div
            data-slot="overlay-footer"
            className="shrink-0 border-t px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
          >
            {footer}
          </div>
        )}
      </Content>
    </Dialog>
  );
}
