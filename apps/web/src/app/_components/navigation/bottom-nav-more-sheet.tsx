import { Link } from "@tanstack/react-router";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { cn, formatBuildDate } from "~/lib/utils";
import { DebugToggleButton } from "./debug-toggle-button";
import { moreNavSections } from "./nav-items";

const buildDate = formatBuildDate(__BUILD_DATE__);

type BottomNavMoreSheetProps = {
  activeTo: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Interaction-only half of the mobile navigation. Keeping the Base UI sheet
 * implementation behind the More button avoids loading it for users who only
 * use the primary tabs.
 */
export function BottomNavMoreSheet({
  activeTo,
  open,
  onOpenChange,
}: BottomNavMoreSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex max-h-[70vh] flex-col rounded-none"
      >
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle>More</SheetTitle>
        </SheetHeader>
        <div className="safe-bottom flex flex-1 flex-col gap-1 overflow-y-auto px-4 pb-6">
          <DebugToggleButton
            compact={false}
            onAfterToggle={() => onOpenChange(false)}
          />

          {moreNavSections.map((section) => (
            <div key={section.title} className="flex flex-col gap-1">
              <div className="eyebrow px-2 pt-4 pb-1">{section.title}</div>
              {section.items.map((item) => {
                const active = item.to === activeTo;
                const Icon = item.icon;

                return (
                  <SheetClose
                    key={item.to}
                    render={
                      <Link
                        to={item.to}
                        className={cn(
                          "flex min-h-[44px] items-center gap-2 rounded-none px-2 py-2 font-medium text-sm transition-colors hover:bg-muted hover:text-primary",
                          !active && "text-muted-foreground",
                          active &&
                            "border-primary border-l-2 bg-muted text-foreground",
                        )}
                        aria-current={active ? "page" : undefined}
                      />
                    }
                  >
                    <Icon className="size-5" />
                    {item.label}
                  </SheetClose>
                );
              })}
            </div>
          ))}
          <div className="mt-auto pt-4 text-center text-muted-foreground text-xs">
            {buildDate} · {__GIT_COMMIT__}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
