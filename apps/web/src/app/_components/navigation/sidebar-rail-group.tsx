import { Link } from "@tanstack/react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { domainWayfinding } from "./domain-wayfinding";
import {
  getSidebarGroupItems,
  type NavGroup,
  type NavItem,
  navItemLinkProps,
} from "./nav-items";
import { NavigationCountBadge } from "./navigation-count-badge";

export function SidebarRailGroup({
  group,
  activeTo,
  expanded = false,
}: {
  group: NavGroup;
  activeTo: string | undefined;
  expanded?: boolean;
}) {
  const children = getSidebarGroupItems(group);
  const active = children.some((item) => item.to === activeTo);
  const Icon = group.icon;
  const domain = group.domain ? domainWayfinding(group.domain) : null;

  return (
    <DropdownMenu>
      <Tooltip lazy={false}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "mb-1 flex h-10 items-center border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none",
                    expanded
                      ? "w-full justify-start gap-2 px-2"
                      : "w-10 justify-center",
                    active && "border-border bg-background text-foreground",
                  )}
                  style={
                    domain
                      ? { borderLeftColor: `var(${domain.accentToken})` }
                      : undefined
                  }
                  aria-label={group.label}
                  aria-current={active ? "page" : undefined}
                />
              }
            />
          }
        >
          <Icon className="size-3.5" />
          {expanded && <span className="truncate text-xs">{group.label}</span>}
        </TooltipTrigger>
        {!expanded && (
          <TooltipContent side="right" role="tooltip">
            {group.label}
          </TooltipContent>
        )}
      </Tooltip>
      <DropdownMenuContent side="right" align="start" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
          {children.map((item) => (
            <SidebarFlyoutItem
              key={item.to}
              item={item}
              active={item.to === activeTo}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SidebarRailLeaf({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <Tooltip lazy={false}>
      <TooltipTrigger
        render={
          <Link
            {...navItemLinkProps(item, active)}
            className={cn(
              "mb-1 flex size-10 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              active && "border-border bg-background text-foreground",
            )}
            aria-label={item.label}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="right" role="tooltip">
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarFlyoutItem({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <DropdownMenuItem
      render={<Link {...navItemLinkProps(item, active)} />}
      className={cn("gap-2", active && "bg-accent")}
    >
      <Icon />
      {item.label}
      {item.entity && <NavigationCountBadge entity={item.entity} />}
    </DropdownMenuItem>
  );
}
