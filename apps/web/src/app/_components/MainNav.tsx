import { Link } from "@tanstack/react-router";
import { Bug, BugOff, LayoutDashboard, Search, Settings } from "lucide-react";
import { FlexContainer } from "~/components/layout/flex-container";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { NavDropdown } from "./navbar/nav-dropdown";
import { NavLink } from "./navbar/nav-link";
import { ProblemsBadge } from "./navbar/problems-badge";
import { QuickActionsMenu } from "./navbar/quick-actions-menu";
import { UserAvatarDropdown } from "./navbar/user-avatar-dropdown";
import {
  design,
  desktopMoreItems,
  docs,
  home,
  inventory,
  kitchenItems,
  locations,
  products,
  projects,
  reportsItems,
} from "./navigation/nav-items";

// Icons for the desktop dropdowns; the links use each NavItem's own icon.
const KitchenIcon = entities.recipe.lucideIcon;
const ReportsIcon = LayoutDashboard;
const SettingsIcon = Settings;

interface MainNavProps extends React.HTMLAttributes<HTMLElement> {
  onSearchClick?: () => void;
}

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({ className, onSearchClick, ...props }: MainNavProps) {
  const { isDebugEnabled, toggleDebug } = useDebug();
  const { data: sessionData, isPending } = authClient.useSession();

  const isAuthed = !!sessionData?.user;
  // Optimistically show the full (authed) nav until the session resolves: the
  // primary user is almost always signed in, so this avoids a flash for them,
  // and keeps SSR + first client render identical (no hydration mismatch). Only
  // once we've confirmed signed-out do we collapse to the minimal public nav.
  const showAuthedNav = isPending || isAuthed;

  return (
    <div className="flex w-full items-center justify-between">
      <Link to="/">
        <FlexContainer align="center" gap={2}>
          <img src="/favicon.svg" alt="" className="h-6 w-6 sm:h-7 sm:w-7" />
          <span className="self-center whitespace-nowrap font-bold text-foreground text-lg tracking-tight sm:text-xl">
            cubby
          </span>
        </FlexContainer>
      </Link>

      {/* Desktop Navigation */}
      <nav
        className={cn(
          "hidden items-center space-x-4 md:flex lg:space-x-6",
          className,
        )}
        {...props}
      >
        <NavLink item={home} />

        {showAuthedNav ? (
          <>
            <NavLink item={products} />
            <NavDropdown
              label="Kitchen"
              items={kitchenItems}
              icon={KitchenIcon}
            />
            <NavLink item={locations} />
            <NavLink item={inventory} />
            <NavLink item={projects} />
            {isAuthed && (
              <NavDropdown
                label="Reports"
                items={reportsItems}
                icon={ReportsIcon}
              />
            )}
            <NavDropdown
              label="Settings"
              items={desktopMoreItems}
              icon={SettingsIcon}
            />
          </>
        ) : (
          <>
            <NavLink item={docs} />
            <NavLink item={design} />
          </>
        )}
      </nav>

      <FlexContainer align="center" gap={2}>
        {/* Search Button */}
        {onSearchClick && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSearchClick}
            className="hidden h-8 px-2 md:flex"
            title="Search"
          >
            <Search className="h-4 w-4" />
            <span className="sr-only">Search</span>
          </Button>
        )}

        {/* Quick Actions */}
        {isAuthed && <QuickActionsMenu />}

        {/* Status Badges */}
        {isAuthed && <ProblemsBadge />}

        {/* Debug Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDebug}
          className={cn(
            "hidden h-8 px-2 md:flex",
            isDebugEnabled && "bg-warning/30 text-accent-foreground",
          )}
          title={isDebugEnabled ? "Disable debug mode" : "Enable debug mode"}
        >
          {isDebugEnabled ? (
            <BugOff className="h-4 w-4" />
          ) : (
            <Bug className="h-4 w-4" />
          )}
          <span className="sr-only">Toggle debug mode</span>
        </Button>

        {isPending ? (
          // Avoid flashing "Sign In" before the session resolves on an
          // authenticated PWA — show a neutral avatar placeholder instead.
          <div
            className="h-7 w-7 animate-pulse rounded-full bg-muted/60"
            aria-hidden
          />
        ) : isAuthed ? (
          <UserAvatarDropdown />
        ) : (
          <Link
            to="/auth/$authView"
            params={{ authView: "sign-in" }}
            className="font-medium text-sm"
          >
            Sign In
          </Link>
        )}
      </FlexContainer>
    </div>
  );
}
