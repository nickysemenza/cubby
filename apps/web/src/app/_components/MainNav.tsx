import { Link, useLocation } from "@tanstack/react-router";
import { Bug, BugOff } from "lucide-react";
import { FlexContainer } from "~/components/layout/flex-container";
import { Button } from "~/components/ui/button";
import { useDebug } from "~/hooks/useDebug";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { NavDropdown } from "./navbar/nav-dropdown";
import { ProblemsBadge } from "./navbar/problems-badge";
import { QuickActionsMenu } from "./navbar/quick-actions-menu";
import { UserAvatarDropdown } from "./navbar/user-avatar-dropdown";
import {
  desktopMoreItems,
  kitchenItems,
  reportsItems,
} from "./navigation/nav-items";
import { SyncStatusBadge } from "./sync/sync-status-badge";

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const pathName = useLocation().pathname;
  const { isDebugEnabled, toggleDebug } = useDebug();
  const session = authClient.useSession();

  return (
    <div className="flex w-full items-center justify-between">
      <Link to="/">
        <FlexContainer align="center" gap={2}>
          <img src="/favicon.svg" alt="" className="h-6 w-6 sm:h-7 sm:w-7" />
          <span className="self-center whitespace-nowrap font-bold text-[#3a3530] text-lg tracking-tight sm:text-xl">
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
        <Link
          to="/"
          className={cn(
            "font-medium text-sm transition-colors hover:text-primary",
            pathName !== "/" && "text-muted-foreground",
          )}
          aria-current={pathName === "/" ? "page" : undefined}
        >
          Home
        </Link>

        <Link
          to="/products"
          className={cn(
            "font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/products") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/products") ? "page" : undefined}
        >
          Products
        </Link>

        <NavDropdown label="Kitchen" items={kitchenItems} />

        <Link
          to="/locations"
          className={cn(
            "font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/locations") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/locations") ? "page" : undefined}
        >
          Locations
        </Link>

        <Link
          to="/inventory"
          className={cn(
            "font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/inventory") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/inventory") ? "page" : undefined}
        >
          Inventory
        </Link>

        {session.data?.user && (
          <NavDropdown label="Reports" items={reportsItems} />
        )}

        <NavDropdown label="More" items={desktopMoreItems} />
      </nav>

      <FlexContainer align="center" gap={2}>
        {/* Quick Actions */}
        {session.data?.user && <QuickActionsMenu />}

        {/* Status Badges - stacked on mobile */}
        <div className="flex flex-col gap-0.5 md:flex-row md:gap-2">
          {session.data?.user && <ProblemsBadge />}
          <SyncStatusBadge />
        </div>

        {/* Debug Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDebug}
          className={cn(
            "hidden h-8 px-2 md:flex",
            isDebugEnabled && "bg-accent/30 text-accent-foreground",
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

        {!session.data?.user ? (
          <Link
            to="/auth/$authView"
            params={{ authView: "sign-in" }}
            className="font-medium text-sm"
          >
            Sign In
          </Link>
        ) : (
          <UserAvatarDropdown />
        )}
      </FlexContainer>
    </div>
  );
}
