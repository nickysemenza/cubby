import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "~/lib/utils";
import type { NavItem } from "../navigation/nav-items";

/**
 * A single top-level desktop nav link. The label is hidden below `lg` so the
 * bar collapses to icons on narrower viewports (matching {@link NavDropdown}).
 */
export const NavLink = ({ item }: { item: NavItem }) => {
  const pathName = useLocation().pathname;
  const active = item.isActive(pathName);
  const Icon = item.icon;

  return (
    <Link
      to={item.href}
      className={cn(
        "nav-link-animated inline-flex items-center gap-1.5 font-medium text-sm transition-colors hover:text-primary",
        !active && "text-muted-foreground",
      )}
      aria-current={active ? "page" : undefined}
      data-status={active ? "active" : undefined}
      title={item.label}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden lg:inline">{item.label}</span>
    </Link>
  );
};
