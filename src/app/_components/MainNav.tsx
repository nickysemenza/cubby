"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { entities } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { PackageOpen } from "lucide-react";

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
  return (
    <div className="flex w-full items-center">
      <Link href="/" className="mr-6 flex items-center space-x-3">
        <PackageOpen />
        <span className="self-center text-2xl font-semibold whitespace-nowrap dark:text-white">
          recipehub
        </span>
      </Link>
      <nav
        className={cn("flex items-center space-x-4 lg:space-x-6", className)}
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
      <div className="ml-auto flex items-center space-x-4">
        <SignedOut>
          <SignInButton />
        </SignedOut>
        <SignedIn>
          <UserButton />
        </SignedIn>
      </div>
    </div>
  );
}
