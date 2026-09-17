import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";

type DialogContentSize = NonNullable<
  ComponentProps<typeof DialogContent>["size"]
>;

/** One Cancel or Submit control promoted into the phone sheet's 52px header. */
interface DialogHeaderAction {
  label: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Native `form` attribute — submits a `<form>` elsewhere in the document. */
  form?: string;
  disabled?: boolean;
}

export interface DialogHeaderActions {
  cancel: DialogHeaderAction;
  submit: DialogHeaderAction;
}

/**
 * Lets a form's own footer (`FormWrapper`'s `footerMode="dialog"`,
 * `DialogFormActions`) hand its Cancel/Submit to the enclosing
 * `ResponsiveDialog` instead of rendering its own button row. The phone sheet
 * promotes them into its 52px header (Cancel / title / submit) and renders no
 * footer, per DESIGN.md's edit-dialog vocabulary; desktop ignores this and the
 * caller keeps its own visible footer. `null` outside a `ResponsiveDialog` (or
 * on desktop, where nothing reads it) — callers must tolerate that.
 */
const DialogHeaderActionsContext = createContext<
  ((actions: DialogHeaderActions | null) => void) | null
>(null);

export function useDialogHeaderActionsRegistration(): ((
  actions: DialogHeaderActions | null,
) => void) | null {
  return useContext(DialogHeaderActionsContext);
}

/**
 * Centered `Dialog` on desktop, bottom `Sheet` on mobile — one primitive so
 * callers (quick-add dialogs, and any future form-in-a-modal) don't hand-roll
 * the `useIsMobile()` branch themselves. Renders the same
 * header/title/description composition either shell uses; `children` is the
 * body (typically a `FormWrapper`), which the mobile branch wraps in a
 * scrollable region so its footer (submit/cancel) stays reachable above the
 * iOS keyboard instead of hiding behind it.
 *
 * Both shells keep the title and optional actions outside the scroll region.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  size = "sm",
  footer,
  bodyMode = "scroll",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Desktop dialog width (`DialogContent`'s size scale). No effect on mobile — the bottom sheet is always full-width. */
  size?: DialogContentSize;
  /** Form body — the scrollable area between the header and footer. */
  children: ReactNode;
  /** Optional actions kept outside the scroll region. */
  footer?: ReactNode;
  /** Let a child form own the scroll region and fixed action footer. */
  bodyMode?: "scroll" | "form";
}) {
  const isMobile = useIsMobile();
  const [headerActions, setHeaderActions] =
    useState<DialogHeaderActions | null>(null);

  if (isMobile) {
    // A registered {cancel, submit} pair (FormWrapper's dialog footer,
    // DialogFormActions) promotes those controls into the sheet's own 52px
    // header and takes over as a full-height sheet with no separate footer —
    // the phone edit-dialog vocabulary. Without one, the sheet keeps its
    // ordinary title/description header and (optional) bottom footer.
    const compactHeader = headerActions != null;
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <DialogHeaderActionsContext.Provider value={setHeaderActions}>
          <SheetContent
            side="bottom"
            showCloseButton={!compactHeader}
            className={cn(
              "flex flex-col p-0 data-[side=bottom]:overflow-hidden data-[side=bottom]:pb-0",
              compactHeader &&
                "data-[side=bottom]:h-[var(--app-viewport-height,100dvh)] data-[side=bottom]:rounded-t-none data-[side=bottom]:border-t-0",
            )}
          >
            {compactHeader && headerActions ? (
              <div className="flex h-[52px] shrink-0 items-center justify-between border-b px-3">
                <button
                  type="button"
                  onClick={headerActions.cancel.onClick}
                  disabled={headerActions.cancel.disabled}
                  className="text-sm text-primary disabled:pointer-events-none disabled:opacity-50"
                >
                  {headerActions.cancel.label}
                </button>
                <span className="text-base font-bold tracking-[-0.01em]">
                  {title}
                </span>
                <button
                  type={headerActions.submit.type ?? "button"}
                  form={headerActions.submit.form}
                  onClick={headerActions.submit.onClick}
                  disabled={headerActions.submit.disabled}
                  className="text-sm font-semibold text-primary disabled:pointer-events-none disabled:opacity-50"
                >
                  {headerActions.submit.label}
                </button>
              </div>
            ) : (
              <SheetHeader className="shrink-0 border-b p-4 pr-16">
                <SheetTitle>{title}</SheetTitle>
                {description && (
                  <SheetDescription>{description}</SheetDescription>
                )}
              </SheetHeader>
            )}
            <div
              className={cn(
                "min-h-0 flex-1",
                bodyMode === "scroll" &&
                  "overflow-y-auto overscroll-contain p-4",
                !footer &&
                  bodyMode === "scroll" &&
                  "pb-[calc(1rem+env(safe-area-inset-bottom))]",
              )}
            >
              {children}
            </div>
            {footer && (
              // `hidden` (not a conditional unmount) once `compactHeader`
              // turns on — the header-actions registration usually lives
              // inside `footer` (DialogFormActions); removing this node would
              // unmount it, firing its cleanup (`registerHeaderActions(null)`)
              // and flipping `compactHeader` back off, which remounts it and
              // registers again: an infinite mount/register loop.
              <div
                data-slot="responsive-dialog-footer"
                className={cn(
                  "shrink-0 border-t bg-popover px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
                  compactHeader && "hidden",
                )}
              >
                {footer}
              </div>
            )}
          </SheetContent>
        </DialogHeaderActionsContext.Provider>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeaderActionsContext.Provider value={setHeaderActions}>
        <DialogContent
          size={size}
          className="flex flex-col gap-0 overflow-hidden p-0"
        >
          <DialogHeader className="shrink-0 border-b pt-3.5 pr-12 pb-2.5 pl-4">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div
            className={cn(
              "min-h-0 flex-1",
              bodyMode === "scroll" && "overflow-y-auto overscroll-contain p-4",
            )}
          >
            {children}
          </div>
          {footer && (
            <div
              data-slot="responsive-dialog-footer"
              className="shrink-0 border-t bg-popover px-4 py-3"
            >
              {footer}
            </div>
          )}
        </DialogContent>
      </DialogHeaderActionsContext.Provider>
    </Dialog>
  );
}
