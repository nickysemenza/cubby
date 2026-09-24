import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { SignInIcon } from "@phosphor-icons/react/dist/csr/SignIn";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";

import { Row } from "~/components/layout";
import type { FilterSearch } from "~/entities/filters";
import { useNavAuthed } from "~/hooks/useNavAuthed";
import { useVirtualKeyboard } from "~/hooks/useVirtualKeyboard";
import { cn } from "~/lib/utils";

import { resolveMobileRoute } from "./mobile-route-descriptor";
import { bottomNavItems, publicNavItems, useActiveTo } from "./nav-items";
import { WorkspaceNavigator } from "./workspace-navigator";

type BottomNavItemProps = {
  icon?: Icon;
  label: string;
  active?: boolean;
  /**
   * Element to render. Defaults to `Link` (the common nav-link case). Pass
   * `as="button"` for the handler-driven trigger (e.g. the "More" sheet).
   */
  as?: React.ElementType;
  className?: string;
  to?: string;
  search?: FilterSearch;
  params?: Readonly<Record<string, string>>;
  type?: "button" | "submit" | "reset";
  onClick?: React.MouseEventHandler<HTMLElement>;
  "aria-label"?: string;
};

interface LinkPreloadProps {
  preload?: "intent";
  preloadDelay?: number;
}

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
  const linkPreloadProps: LinkPreloadProps = {};
  if (Comp === Link) {
    linkPreloadProps.preload = "intent";
    linkPreloadProps.preloadDelay = 0;
  }

  return (
    <Comp
      className={cn(
        // A quiet Porcelain Transit tab: cobalt identifies the current route;
        // color never substitutes for the visible label or aria-current state.
        "relative flex min-h-[48px] min-w-[48px] flex-1 flex-col items-center justify-center gap-1 transition-colors active:bg-muted/60",
        active
          ? "text-primary before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:bg-primary"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      aria-current={active ? "page" : undefined}
      {...linkPreloadProps}
      {...rest}
    >
      {Icon && (
        <Icon
          className="size-5"
          weight={active ? "fill" : "regular"}
          aria-hidden="true"
        />
      )}
      <span className="text-2xs font-medium">{label}</span>
    </Comp>
  );
}

export function BottomNav() {
  const activeTo = useActiveTo();
  const pathname = useLocation().pathname;
  const activeTab = resolveMobileRoute(pathname).tab;
  const keyboardOpen = useVirtualKeyboard();
  const [isOpen, setIsOpen] = React.useState(false);
  const [moreMounted, setMoreMounted] = React.useState(false);
  // SSR-accurate auth (see useNavAuthed): the tab bar renders the right state
  // on the first paint instead of flashing the authed tabs and collapsing.
  const authed = useNavAuthed();

  const isMoreActive = activeTab === "more";

  return (
    <nav
      className={cn(
        "safe-bottom fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card md:hidden print:hidden",
        keyboardOpen && "hidden",
      )}
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
                search={item.search}
                icon={item.icon}
                label={item.label}
                active={
                  (item.to === "/" && activeTab === "today") ||
                  (item.to === "/inventory" && activeTab === "inventory") ||
                  (item.to === "/scan" && activeTab === "scan") ||
                  (item.to === "/search" && activeTab === "search")
                }
              />
            ))}

            <BottomNavItem
              as="button"
              type="button"
              icon={DotsThreeIcon}
              label="More"
              active={isMoreActive}
              aria-label="More options"
              onClick={() => {
                setMoreMounted(true);
                setIsOpen(true);
              }}
            />
            {moreMounted && (
              <WorkspaceNavigator
                activeTo={activeTo}
                open={isOpen}
                onOpenChange={setIsOpen}
                initialView="household"
              />
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
              icon={SignInIcon}
              label="Sign In"
            />
          </>
        )}
      </Row>
    </nav>
  );
}
