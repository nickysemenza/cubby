import { Link, useLocation } from "@tanstack/react-router";
import {
  Bug,
  BugOff,
  Hammer,
  Home,
  LayoutDashboard,
  Search,
  Settings,
} from "lucide-react";
import { FlexContainer } from "~/components/layout/flex-container";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
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

// Icons for desktop nav
const HomeIcon = Home;
const ProductsIcon = entities.product.lucideIcon;
const LocationsIcon = entities.location.lucideIcon;
const InventoryIcon = entities.inventory.lucideIcon;
const KitchenIcon = entities.recipe.lucideIcon;
const ReportsIcon = LayoutDashboard;
const SettingsIcon = Settings;

interface MainNavProps extends React.HTMLAttributes<HTMLElement> {
  onSearchClick?: () => void;
}

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({ className, onSearchClick, ...props }: MainNavProps) {
  const pathName = useLocation().pathname;
  const { isDebugEnabled, toggleDebug } = useDebug();
  const session = authClient.useSession();

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
        <Link
          to="/"
          className={cn(
            "nav-link-animated inline-flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary",
            pathName !== "/" && "text-muted-foreground",
          )}
          aria-current={pathName === "/" ? "page" : undefined}
          data-status={pathName === "/" ? "active" : undefined}
          title="Home"
        >
          <HomeIcon className="h-4 w-4" />
          <span className="hidden xl:inline">Home</span>
        </Link>

        <Link
          to="/products"
          className={cn(
            "nav-link-animated inline-flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/products") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/products") ? "page" : undefined}
          data-status={pathName.startsWith("/products") ? "active" : undefined}
          title="Products"
        >
          <ProductsIcon className="h-4 w-4" />
          <span className="hidden xl:inline">Products</span>
        </Link>

        <NavDropdown label="Kitchen" items={kitchenItems} icon={KitchenIcon} />

        <Link
          to="/locations"
          className={cn(
            "nav-link-animated inline-flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/locations") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/locations") ? "page" : undefined}
          data-status={pathName.startsWith("/locations") ? "active" : undefined}
          title="Locations"
        >
          <LocationsIcon className="h-4 w-4" />
          <span className="hidden xl:inline">Locations</span>
        </Link>

        <Link
          to="/inventory"
          className={cn(
            "nav-link-animated inline-flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/inventory") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/inventory") ? "page" : undefined}
          data-status={pathName.startsWith("/inventory") ? "active" : undefined}
          title="Inventory"
        >
          <InventoryIcon className="h-4 w-4" />
          <span className="hidden xl:inline">Inventory</span>
        </Link>

        <Link
          to="/projects"
          className={cn(
            "nav-link-animated inline-flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary",
            !pathName.startsWith("/projects") && "text-muted-foreground",
          )}
          aria-current={pathName.startsWith("/projects") ? "page" : undefined}
          data-status={pathName.startsWith("/projects") ? "active" : undefined}
          title="Projects"
        >
          <Hammer className="h-4 w-4" />
          <span className="hidden xl:inline">Projects</span>
        </Link>

        {session.data?.user && (
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
      </nav>

      <FlexContainer align="center" gap={2}>
        {/* Search Button */}
        {onSearchClick && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSearchClick}
            className="h-8 px-2"
            title="Search"
          >
            <Search className="h-4 w-4" />
            <span className="sr-only">Search</span>
          </Button>
        )}

        {/* Quick Actions */}
        {session.data?.user && <QuickActionsMenu />}

        {/* Status Badges */}
        {session.data?.user && <ProblemsBadge />}

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
