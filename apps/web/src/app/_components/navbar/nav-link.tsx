import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import {
  type NavItem,
  navItemLinkProps,
  useActiveTo,
} from "../navigation/nav-items";

/**
 * A single top-level desktop nav link. The label is hidden below `lg` so the
 * bar collapses to icons on narrower viewports (matching {@link NavDropdown}).
 */
export const NavLink = ({ item }: { item: NavItem }) => {
  const active = useActiveTo() === item.to;
  const Icon = item.icon;

  return (
    <Link
      {...navItemLinkProps(item, active)}
      className={cn(
        "nav-link-animated inline-flex items-center gap-2 text-sm font-medium transition-colors hover:text-primary",
        !active && "text-muted-foreground",
      )}
      data-status={active ? "active" : undefined}
      title={item.label}
    >
      <Icon className="size-3.5" weight={active ? "bold" : "regular"} />
      <span className="hidden lg:inline">{item.label}</span>
    </Link>
  );
};
