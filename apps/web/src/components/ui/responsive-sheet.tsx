import type { ReactNode } from "react";
import { useIsMobile } from "~/hooks/useMobile";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

/** Right-side workspace panel on desktop and thumb-reachable bottom sheet on
 * phones. Navigation and filtering surfaces share this shell rather than
 * duplicating media-query branches. */
export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "flex max-h-[90dvh] flex-col p-0 data-[side=bottom]:overflow-hidden data-[side=bottom]:pb-0 md:max-h-none",
          className,
        )}
      >
        <SheetHeader className="shrink-0 border-border border-b p-4 pr-16">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
