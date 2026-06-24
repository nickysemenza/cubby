import { Link } from "@tanstack/react-router";
import { Bug, BugOff, LogIn, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";
import { useDebug } from "~/hooks/useDebug";
import { useNavAuthed } from "~/hooks/useNavAuthed";
import { cn, formatBuildDate } from "~/lib/utils";
import {
  bottomNavItems,
  moreNavItems,
  publicNavItems,
  useActiveTo,
} from "./nav-items";

const buildDate = formatBuildDate(__BUILD_DATE__);

export function BottomNav() {
  const activeTo = useActiveTo();
  const [isOpen, setIsOpen] = useState(false);
  const { isDebugEnabled, toggleDebug } = useDebug();
  // SSR-accurate auth (see useNavAuthed): the tab bar renders the right state
  // on the first paint instead of flashing the authed tabs and collapsing.
  const authed = useNavAuthed();

  // Check if any "more" item is active
  const isMoreActive = moreNavItems.some((item) => item.to === activeTo);

  return (
    <nav
      className="safe-bottom fixed inset-x-0 bottom-0 z-50 border-t-2 border-t-[var(--border-chunky)] bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden print:hidden"
      style={{ viewTransitionName: "bottom-nav" }}
      aria-label="Main navigation"
    >
      <Row align="center" justify="around" className="h-16">
        {authed ? (
          <>
            {bottomNavItems.map((item) => {
              const active = item.to === activeTo;
              const Icon = item.icon;

              return (
                <Link
                  key={item.to}
                  to={item.to}
                  // `search` can't be correlated to the union `to` here; only
                  // the Scan shortcut sets it (see nav-items). Cast is local.
                  search={item.search as never}
                  className={cn(
                    "flex min-h-[48px] min-w-[48px] flex-1 flex-col items-center justify-center gap-1 transition-colors active:bg-muted/60",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {Icon && (
                    <Icon
                      className={cn("h-5 w-5", active && "scale-110")}
                      aria-hidden="true"
                    />
                  )}
                  <span className="font-medium text-2xs">{item.label}</span>
                </Link>
              );
            })}

            {/* More button with sheet */}
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
              <SheetTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "flex min-h-[48px] min-w-[48px] flex-1 flex-col items-center justify-center gap-1 transition-colors active:bg-muted/60",
                      isMoreActive
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-label="More options"
                  />
                }
              >
                <MoreHorizontal
                  className={cn("h-5 w-5", isMoreActive && "scale-110")}
                  aria-hidden="true"
                />
                <span className="font-medium text-2xs">More</span>
              </SheetTrigger>
              <SheetContent
                side="bottom"
                className="flex max-h-[70vh] flex-col rounded-t-xl"
              >
                <SheetHeader className="px-4 pt-4 pb-2">
                  <SheetTitle>More</SheetTitle>
                </SheetHeader>
                <div className="safe-bottom flex flex-1 flex-col gap-1 overflow-y-auto px-4 pb-6">
                  {/* Debug Toggle */}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      toggleDebug();
                      setIsOpen(false);
                    }}
                    className={cn(
                      "min-h-[44px] justify-start px-2 py-2 text-sm",
                      isDebugEnabled && "bg-warning/30 text-accent-foreground",
                    )}
                  >
                    {isDebugEnabled ? (
                      <BugOff className="mr-2 h-4 w-4" />
                    ) : (
                      <Bug className="mr-2 h-4 w-4" />
                    )}
                    {isDebugEnabled ? "Disable Debug" : "Enable Debug"}
                  </Button>

                  {/* Nav items */}
                  {moreNavItems.map((item) => {
                    const active = item.to === activeTo;
                    const Icon = item.icon;

                    // Only show Dashboard if signed in
                    if (item.to === "/dashboard" && !authed) {
                      return null;
                    }

                    return (
                      <SheetClose
                        key={item.to}
                        render={
                          <Link
                            to={item.to}
                            className={cn(
                              "flex min-h-[44px] items-center gap-2 rounded-md px-2 py-2 font-medium text-sm transition-colors hover:bg-muted hover:text-primary",
                              !active && "text-muted-foreground",
                              active && "bg-muted text-foreground",
                            )}
                            aria-current={active ? "page" : undefined}
                          />
                        }
                      >
                        <Icon className="h-5 w-5" />
                        {item.label}
                      </SheetClose>
                    );
                  })}
                  <div className="mt-auto pt-4 text-center text-muted-foreground text-xs">
                    {buildDate} · {__GIT_COMMIT__}
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </>
        ) : (
          <>
            {publicNavItems.map((item) => {
              const active = item.to === activeTo;
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex min-h-[48px] min-w-[48px] flex-1 flex-col items-center justify-center gap-1 transition-colors active:bg-muted/60",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon
                    className={cn("h-5 w-5", active && "scale-110")}
                    aria-hidden="true"
                  />
                  <span className="font-medium text-2xs">{item.label}</span>
                </Link>
              );
            })}
            <Link
              to="/auth/$authView"
              params={{ authView: "sign-in" }}
              className="flex min-h-[48px] min-w-[48px] flex-1 flex-col items-center justify-center gap-1 text-muted-foreground transition-colors hover:text-foreground active:bg-muted/60"
            >
              <LogIn className="h-5 w-5" aria-hidden="true" />
              <span className="font-medium text-2xs">Sign In</span>
            </Link>
          </>
        )}
      </Row>
    </nav>
  );
}
