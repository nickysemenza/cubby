import { Link } from "@tanstack/react-router";
import { Bug, BugOff, LogIn, MoreHorizontal } from "lucide-react";
import type * as React from "react";
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
  moreNavSections,
  publicNavItems,
  useActiveTo,
} from "./nav-items";

const buildDate = formatBuildDate(__BUILD_DATE__);

type BottomNavItemProps = {
  /** Optional leading icon. Scales up subtly when `active`. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Short label rendered under the icon. */
  label: string;
  /** Active (current) tab — drives the primary color + icon scale. */
  active?: boolean;
  /**
   * Element to render. Defaults to `Link` (the common nav-link case). Pass
   * `as="button"` for the handler-driven trigger (e.g. the "More" sheet).
   */
  as?: React.ElementType;
  className?: string;
} & Record<string, unknown>;

/**
 * The shared bottom-nav tab shape (icon over label, 48px touch target). Renders
 * a `Link` by default; `as="button"` covers the handler/trigger case. Extra
 * props (`to`/`search`/`params`/`aria-*`, or trigger props injected by a base-ui
 * `render` slot) forward straight to the rendered element.
 */
function BottomNavItem({
  icon: Icon,
  label,
  active = false,
  as: Comp = Link,
  className,
  ...rest
}: BottomNavItemProps) {
  return (
    <Comp
      className={cn(
        // Flat ledger tab — the active tab is marked by a square ultramarine
        // top-rule + ink label (no icon bounce, no rounded pill).
        "relative flex min-h-[48px] min-w-[48px] flex-1 flex-col items-center justify-center gap-1 transition-colors active:bg-muted/60",
        active
          ? "text-primary before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:bg-primary"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      aria-current={active ? "page" : undefined}
      {...rest}
    >
      {Icon && <Icon className="h-5 w-5" aria-hidden="true" />}
      <span className="font-medium text-2xs">{label}</span>
    </Comp>
  );
}

export function BottomNav() {
  const activeTo = useActiveTo();
  const [isOpen, setIsOpen] = useState(false);
  const { isDebugEnabled, toggleDebug } = useDebug();
  // SSR-accurate auth (see useNavAuthed): the tab bar renders the right state
  // on the first paint instead of flashing the authed tabs and collapsing.
  const authed = useNavAuthed();

  // Check if any "more" item is active
  const isMoreActive = moreNavSections.some((section) =>
    section.items.some((item) => item.to === activeTo),
  );

  return (
    <nav
      // Warm-Paper Ledger: a flat opaque paper-surface bar edged by the 3px ink
      // top-rule — separation by rule and tone, no raised/blurred/translucent
      // chrome.
      className="safe-bottom fixed inset-x-0 bottom-0 z-50 border-t-[3px] border-t-foreground bg-card md:hidden print:hidden"
      style={{ viewTransitionName: "bottom-nav" }}
      aria-label="Main navigation"
    >
      <Row align="center" justify="around" className="h-14">
        {authed ? (
          <>
            {bottomNavItems.map((item) => (
              <BottomNavItem
                key={item.to}
                to={item.to}
                // `search` can't be correlated to the union `to` here; only
                // the Scan shortcut sets it (see nav-items). Cast is local.
                search={item.search as never}
                icon={item.icon}
                label={item.label}
                active={item.to === activeTo}
              />
            ))}

            {/* More button with sheet */}
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
              <SheetTrigger
                render={
                  <BottomNavItem
                    as="button"
                    type="button"
                    icon={MoreHorizontal}
                    label="More"
                    active={isMoreActive}
                    aria-label="More options"
                  />
                }
              />
              <SheetContent
                side="bottom"
                className="flex max-h-[70vh] flex-col rounded-none"
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

                  {/* Nav items, grouped into labeled sections */}
                  {moreNavSections.map((section) => (
                    <div key={section.title} className="flex flex-col gap-1">
                      <div className="px-2 pt-4 pb-1 font-mono text-2xs text-muted-foreground uppercase tracking-wider">
                        {section.title}
                      </div>
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
                            <Icon className="h-5 w-5" />
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
          </>
        ) : (
          <>
            {publicNavItems.map((item) => (
              <BottomNavItem
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={item.label}
                active={item.to === activeTo}
              />
            ))}
            <BottomNavItem
              to="/auth/$authView"
              params={{ authView: "sign-in" }}
              icon={LogIn}
              label="Sign In"
            />
          </>
        )}
      </Row>
    </nav>
  );
}
