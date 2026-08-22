import { Link } from "@tanstack/react-router";
import { LogIn, MoreHorizontal } from "lucide-react";
import * as React from "react";
import { Row } from "~/components/layout";
import { useNavAuthed } from "~/hooks/useNavAuthed";
import { createCachedLoader, scheduleIdlePreload } from "~/lib/lazy-preload";
import { cn } from "~/lib/utils";
import {
  bottomNavItems,
  moreNavSections,
  publicNavItems,
  useActiveTo,
  workspaceUtilitySections,
} from "./nav-items";

const importWorkspaceNavigator = createCachedLoader(() =>
  import("./workspace-navigator").then((m) => ({
    default: m.WorkspaceNavigator,
  })),
);

const loadWorkspaceNavigator = () => importWorkspaceNavigator();

const WorkspaceNavigator = React.lazy(loadWorkspaceNavigator);

type BottomNavItemProps = {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
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
      {...(Comp === Link
        ? { preload: "intent" as const, preloadDelay: 0 }
        : {})}
      {...rest}
    >
      {Icon && <Icon className="size-5" aria-hidden="true" />}
      <span className="font-medium text-2xs">{label}</span>
    </Comp>
  );
}

export function BottomNav() {
  const activeTo = useActiveTo();
  const [isOpen, setIsOpen] = React.useState(false);
  const [moreMounted, setMoreMounted] = React.useState(false);
  // SSR-accurate auth (see useNavAuthed): the tab bar renders the right state
  // on the first paint instead of flashing the authed tabs and collapsing.
  const authed = useNavAuthed();

  React.useEffect(() => {
    if (!authed || !window.matchMedia("(max-width: 767px)").matches) return;
    return scheduleIdlePreload(window, () => void loadWorkspaceNavigator(), {
      timeoutMs: 1_500,
      fallbackMs: 400,
    });
  }, [authed]);

  const isMoreActive = [...moreNavSections, ...workspaceUtilitySections].some(
    (section) => section.items.some((item) => item.to === activeTo),
  );

  return (
    <nav
      // Warm-Paper Ledger: a flat opaque paper-surface bar edged by the 3px ink
      // top-rule — separation by rule and tone, no raised/blurred/translucent
      // chrome.
      className="safe-bottom fixed inset-x-0 bottom-0 z-50 border-t-[3px] border-t-foreground bg-card md:hidden print:hidden"
      aria-label="Main navigation"
    >
      <Row align="center" justify="around" className="h-14">
        {authed ? (
          <>
            {bottomNavItems.map((item) => (
              <BottomNavItem
                key={item.to}
                to={item.to}
                // `search` can't be correlated to the union `to` here. Keep
                // the local cast so manifest-backed shortcuts can add static
                // search state without widening every bottom-tab route.
                search={item.search as never}
                icon={item.icon}
                label={item.label}
                active={item.to === activeTo}
              />
            ))}

            <BottomNavItem
              as="button"
              type="button"
              icon={MoreHorizontal}
              label="More"
              active={isMoreActive}
              aria-label="More options"
              onPointerEnter={() => void loadWorkspaceNavigator()}
              onTouchStart={() => void loadWorkspaceNavigator()}
              onClick={() => {
                setMoreMounted(true);
                setIsOpen(true);
              }}
            />
            {moreMounted && (
              <React.Suspense fallback={null}>
                <WorkspaceNavigator
                  activeTo={activeTo}
                  open={isOpen}
                  onOpenChange={setIsOpen}
                  initialView="household"
                />
              </React.Suspense>
            )}
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
