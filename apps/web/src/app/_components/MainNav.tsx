import { OrganizationSwitcher } from "@daveyplate/better-auth-ui";
import { Link, useLocation } from "@tanstack/react-router";
import { Bug, BugOff, Menu, PackageOpen } from "lucide-react";
import { FlexContainer } from "~/components/layout/flex-container";
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
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { NavDropdown } from "./navbar/nav-dropdown";
import { ProblemsBadge } from "./navbar/problems-badge";
import { QuickActionsMenu } from "./navbar/quick-actions-menu";
import { UserAvatarDropdown } from "./navbar/user-avatar-dropdown";
import { SyncStatusBadge } from "./sync/sync-status-badge";

type NavItem = {
  href: string;
  label: string;
  isActive(pathName: string): boolean;
};

// Grouped navigation for desktop
const kitchenItems: NavItem[] = [
  {
    href: "/ingredients",
    label: "Ingredients",
    isActive: (pathname) => pathname.startsWith("/ingredients"),
  },
  {
    href: "/recipes",
    label: "Recipes",
    isActive: (pathname) => pathname.startsWith("/recipes"),
  },
  {
    href: "/usda",
    label: "USDA Foods",
    isActive: (pathname) => pathname.startsWith("/usda"),
  },
];

const reportsItems: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    isActive: (pathname) => pathname === "/dashboard",
  },
  {
    href: "/activity",
    label: "Activity",
    isActive: (pathname) => pathname.startsWith("/activity"),
  },
  {
    href: "/insights",
    label: "Insights",
    isActive: (pathname) => pathname.startsWith("/insights"),
  },
  {
    href: "/problems",
    label: "Problems",
    isActive: (pathname) => pathname.startsWith("/problems"),
  },
];

const moreItems: NavItem[] = [
  {
    href: "/images",
    label: "Images",
    isActive: (pathname) => pathname.startsWith("/images"),
  },
  {
    href: "/settings/integrations",
    label: "Integrations",
    isActive: (pathname) => pathname.startsWith("/settings/integrations"),
  },
  {
    href: "/api/panel",
    label: "API Panel",
    isActive: () => false,
  },
];

// All items for mobile menu
const allNavItems: NavItem[] = [
  {
    href: "/",
    label: "Home",
    isActive: (pathname) => pathname === "/",
  },
  {
    href: "/products",
    label: "Products",
    isActive: (pathname) => pathname.startsWith("/products"),
  },
  ...kitchenItems,
  {
    href: "/locations",
    label: "Locations",
    isActive: (pathname) => pathname.startsWith("/locations"),
  },
  {
    href: "/inventory",
    label: "Inventory",
    isActive: (pathname) => pathname.startsWith("/inventory"),
  },
  ...reportsItems,
  ...moreItems,
];

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
          <PackageOpen className="h-5 w-5 sm:h-6 sm:w-6" />
          <span className="self-center whitespace-nowrap font-semibold text-base sm:text-2xl">
            recipehub
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

        <NavDropdown label="More" items={moreItems} />
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
            isDebugEnabled && "bg-orange-50 text-orange-600",
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
          <>
            <div className="hidden md:block">
              <OrganizationSwitcher />
            </div>
            <UserAvatarDropdown />
          </>
        )}

        {/* Mobile menu button */}
        <Sheet>
          <SheetTrigger
            render={
              <button
                type="button"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md p-2 transition-colors hover:bg-muted md:hidden"
                aria-label="Toggle menu"
              />
            }
          >
            <Menu size={24} />
          </SheetTrigger>
          <SheetContent side="left" className="flex w-72 flex-col">
            <SheetHeader className="p-4 pb-2">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-1 flex-col space-y-1 overflow-y-auto px-4 pb-4">
              {/* Organization Switcher for Mobile */}
              {session.data?.user && (
                <div className="flex min-h-[44px] items-center justify-between px-3 py-2">
                  <span className="font-medium text-sm">Organization</span>
                  <OrganizationSwitcher />
                </div>
              )}

              {/* Debug Toggle for Mobile */}
              <SheetClose
                render={
                  <Button
                    variant="ghost"
                    onClick={toggleDebug}
                    className={cn(
                      "min-h-[44px] justify-start px-3 py-2 text-sm",
                      isDebugEnabled && "bg-orange-50 text-orange-600",
                    )}
                  />
                }
              >
                {isDebugEnabled ? (
                  <BugOff className="mr-2 h-4 w-4" />
                ) : (
                  <Bug className="mr-2 h-4 w-4" />
                )}
                {isDebugEnabled ? "Disable Debug" : "Enable Debug"}
              </SheetClose>
              {allNavItems.map((item) => {
                const active = item.isActive(pathName);

                // Only show Dashboard link if user is signed in
                if (item.href === "/dashboard" && !session.data?.user) {
                  return null;
                }

                return (
                  <SheetClose
                    key={item.href}
                    render={
                      <Link
                        to={item.href}
                        className={cn(
                          "flex min-h-[44px] items-center rounded-md px-3 py-2 font-medium text-sm transition-colors hover:bg-muted hover:text-primary",
                          !active && "text-muted-foreground",
                          active && "bg-muted text-foreground",
                        )}
                        aria-current={active ? "page" : undefined}
                      />
                    }
                  >
                    {item.label}
                  </SheetClose>
                );
              })}
            </nav>
          </SheetContent>
        </Sheet>
      </FlexContainer>
    </div>
  );
}
