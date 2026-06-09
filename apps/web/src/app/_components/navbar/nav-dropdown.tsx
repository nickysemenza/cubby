import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import type { NavItem } from "../navigation/nav-items";

type NavDropdownProps = {
  label: string;
  items: NavItem[];
  /** Optional icon to show next to the label */
  icon?: LucideIcon;
};

export const NavDropdown = ({ label, items, icon: Icon }: NavDropdownProps) => {
  const pathName = useLocation().pathname;

  // Check if any item in this group is active
  const isGroupActive = items.some((item) => item.isActive(pathName));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "nav-link-animated flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary focus:outline-none",
          isGroupActive ? "text-foreground" : "text-muted-foreground",
        )}
        data-status={isGroupActive ? "active" : undefined}
        title={label}
      >
        {Icon && <Icon className="h-4 w-4" />}
        <span className="hidden lg:inline">{label}</span>
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {items.map((item) => {
          const active = item.isActive(pathName);
          const ItemIcon = item.icon;
          return (
            <DropdownMenuItem
              key={item.href}
              render={<Link to={item.href} />}
              className={cn("gap-2", active && "bg-accent")}
            >
              <ItemIcon className="h-4 w-4" />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
