"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "~/lib/utils";

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
  ...[
    "recipes",
    "ingredients",
    "locations",
    "products",
    "inventory",
    "demo",
  ].map(
    (item): NavItem => ({
      href: `/${item}`,
      label: item,
      isActive: (pathname) => pathname.startsWith(`/${item}`),
    }),
  ),
  { href: "/api/panel", label: "API Panel", isActive: () => false },
];

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const pathName = usePathname();
  return (
    <nav
      className={cn("flex items-center space-x-4 lg:space-x-6", className)}
      {...props}
    >
      {NavItems.map((item) => {
        const active = item.isActive(pathName);
        return (
          <Link
            href={item.href}
            key={item.href}
            // className={`${active ? "bg-blue-700" : undefined} block rounded-sm px-3 py-2 text-gray-900 hover:bg-gray-100 md:p-0 md:hover:bg-transparent md:hover:text-blue-700 dark:border-gray-700 dark:text-white dark:hover:bg-gray-700 dark:hover:text-white md:dark:hover:bg-transparent md:dark:hover:text-blue-500`}
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
  );
}
