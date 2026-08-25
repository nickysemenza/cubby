import type { ComponentProps, ReactNode } from "react";
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

type DialogContentSize = NonNullable<
  ComponentProps<typeof DialogContent>["size"]
>;

/**
 * Centered `Dialog` on desktop, bottom `Sheet` on mobile — one primitive so
 * callers (quick-add dialogs, and any future form-in-a-modal) don't hand-roll
 * the `useIsMobile()` branch themselves. Renders the same
 * header/title/description composition either shell uses; `children` is the
 * body (typically a `FormWrapper`), which the mobile branch wraps in a
 * scrollable region so its footer (submit/cancel) stays reachable above the
 * iOS keyboard instead of hiding behind it.
 *
 * Desktop output matches the pre-existing `Dialog` + `DialogContent size="sm"`
 * + `DialogHeader`/`DialogTitle`/`DialogDescription` composition exactly — this
 * is a lossless extraction, not a redesign of the desktop path.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  size = "sm",
  footer,
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
  /** Optional actions kept outside the mobile scroll region. */
  footer?: ReactNode;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="flex flex-col p-0">
          <SheetHeader className="shrink-0 border-b p-4">
            <SheetTitle>{title}</SheetTitle>
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            {children}
          </div>
          {footer && (
            <div className="shrink-0 border-t bg-popover p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {footer}
            </div>
          )}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {footer}
      </DialogContent>
    </Dialog>
  );
}
