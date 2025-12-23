"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { entities } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { authClient } from "~/lib/auth-client";
import { Menu, PackageOpen, Bug, BugOff } from "lucide-react";
import { useDebug } from "~/hooks/useDebug";
import { Button } from "~/components/ui/button";
import { ThemeToggle } from "~/components/ui/theme-toggle";
import { OrganizationSwitcher } from "@daveyplate/better-auth-ui";
import { FlexContainer } from "~/components/layout/flex-container";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from "~/components/ui/sheet";

type NavItem = {
  href: string;
  label: string;
  isActive(pathName: string): boolean;
};
const NavItems: NavItem[] = [
  {
    href: "/",
    label: "Home",
    isActive: (pathname) => pathname === "/",
  },
  ...Object.values(entities).map(
    (item): NavItem => ({
      href: `/${item.basePath}`,
      label: item.pluralLabel,
      isActive: (pathname) => pathname.startsWith(`/${item.basePath}`),
    }),
  ),
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
    href: "/problems",
    label: "Problems",
    isActive: (pathname) => pathname.startsWith("/problems"),
  },
  { href: "/api/panel", label: "API Panel", isActive: () => false },
];

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const pathName = usePathname();
  const { isDebugEnabled, toggleDebug } = useDebug();
  const session = authClient.useSession();

  return (
    <div className="flex w-full items-center justify-between">
      <Link href="/">
        <FlexContainer align="center" gap={3}>
          <PackageOpen />
          <span className="self-center text-2xl font-semibold whitespace-nowrap dark:text-white">
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
        {NavItems.map((item) => {
          const active = item.isActive(pathName);

          // Only show Dashboard link if it's not the Dashboard link or user is signed in
          if (item.href === "/dashboard") {
            if (!session.data?.user) return null;
            return (
              <Link
                href={item.href}
                key={item.href}
                className={cn(
                  "hover:text-primary text-sm font-medium transition-colors",
                  !active && "text-muted-foreground",
                )}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          }

          return (
            <Link
              href={item.href}
              key={item.href}
              className={cn(
                "hover:text-primary text-sm font-medium transition-colors",
                !active && "text-muted-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <FlexContainer align="center" gap={4}>
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* Debug Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDebug}
          className={cn(
            "hidden md:flex",
            isDebugEnabled &&
              "bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400",
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
          <Link href="/auth/sign-in" className="text-sm font-medium">
            Sign In
          </Link>
        ) : (
          <>
            <OrganizationSwitcher />
            <Button
              variant="outline"
              size="sm"
              onClick={() => authClient.signOut()}
            >
              Sign Out
            </Button>
          </>
        )}

        {/* Mobile menu button */}
        <Sheet>
          <SheetTrigger
            render={
              <button className="p-2 md:hidden" aria-label="Toggle menu" />
            }
          >
            <Menu size={24} />
          </SheetTrigger>
          <SheetContent side="left" className="w-72">
            <SheetHeader>
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col space-y-4 p-4">
              {/* Theme Toggle for Mobile */}
              <div className="flex items-center justify-between p-2">
                <span className="text-base font-medium">Theme</span>
                <ThemeToggle />
              </div>

              {/* Debug Toggle for Mobile */}
              <SheetClose
                render={
                  <Button
                    variant="ghost"
                    onClick={toggleDebug}
                    className={cn(
                      "h-auto justify-start p-2",
                      isDebugEnabled &&
                        "bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400",
                    )}
                  />
                }
              >
                {isDebugEnabled ? (
                  <BugOff className="mr-2 h-4 w-4" />
                ) : (
                  <Bug className="mr-2 h-4 w-4" />
                )}
                {isDebugEnabled ? "Disable Debug Mode" : "Enable Debug Mode"}
              </SheetClose>
              {NavItems.map((item) => {
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
                        href={item.href}
                        className={cn(
                          "hover:text-primary p-2 text-base font-medium transition-colors",
                          !active && "text-muted-foreground",
                          active && "bg-muted rounded",
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
