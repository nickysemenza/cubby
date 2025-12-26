"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

type NavItem = {
  href: string;
  label: string;
  isActive(pathName: string): boolean;
};

type NavDropdownProps = {
  label: string;
  items: NavItem[];
};

export const NavDropdown = ({ label, items }: NavDropdownProps) => {
  const pathName = usePathname();

  // Check if any item in this group is active
  const isGroupActive = items.some((item) => item.isActive(pathName));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "hover:text-primary flex items-center gap-1 text-sm font-medium transition-colors focus:outline-none",
          isGroupActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {items.map((item) => {
          const active = item.isActive(pathName);
          return (
            <DropdownMenuItem
              key={item.href}
              render={<Link href={item.href} />}
              className={cn(active && "bg-accent")}
            >
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
