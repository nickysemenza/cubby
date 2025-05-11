"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { entities } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { Menu, PackageOpen, X } from "lucide-react";
import { useState } from "react";

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
  { href: "/api/panel", label: "API Panel", isActive: () => false },
];

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const pathName = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex w-full items-center justify-between">
      <Link href="/" className="flex items-center space-x-3">
        <PackageOpen />
        <span className="self-center text-2xl font-semibold whitespace-nowrap dark:text-white">
          recipehub
        </span>
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
            return (
              <SignedIn key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "hover:text-primary text-sm font-medium transition-colors",
                    !active && "text-muted-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </SignedIn>
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

      <div className="flex items-center space-x-4">
        <SignedOut>
          <SignInButton />
        </SignedOut>
        <SignedIn>
          <UserButton />
        </SignedIn>

        {/* Mobile menu button */}
        <button
          className="p-2 md:hidden"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <div className="bg-background fixed inset-0 top-16 z-50 md:hidden">
          <nav className="flex flex-col space-y-4 p-4">
            {NavItems.map((item) => {
              const active = item.isActive(pathName);

              // Only show Dashboard link if it's not the Dashboard link or user is signed in
              if (item.href === "/dashboard") {
                return (
                  <SignedIn key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "hover:text-primary p-2 text-base font-medium transition-colors",
                        !active && "text-muted-foreground",
                        active && "bg-muted rounded",
                      )}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      {item.label}
                    </Link>
                  </SignedIn>
                );
              }

              return (
                <Link
                  href={item.href}
                  key={item.href}
                  className={cn(
                    "hover:text-primary p-2 text-base font-medium transition-colors",
                    !active && "text-muted-foreground",
                    active && "bg-muted rounded",
                  )}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </div>
  );
}
