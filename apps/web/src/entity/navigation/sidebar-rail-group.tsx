import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

import { NavigationCountBadge } from "../../ui/navigation/navigation-count-badge";
import {
  getSidebarGroupItems,
  type NavGroup,
  type NavItem,
  navItemLinkProps,
} from "./nav-items";

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
                    "mb-0.5 flex h-7 items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus:outline-none",
                    expanded
                      ? "w-full justify-start gap-2 px-2"
                      : "w-7 justify-center",
                    active && "bg-muted text-foreground hover:bg-muted",
                  )}
                  aria-label={group.label}
                  aria-current={active ? "page" : undefined}
                />
              }
            />
          }
        >
          <Icon
            className="size-3.5 text-foreground"
            weight={active ? "bold" : "regular"}
            aria-hidden="true"
          />
          {expanded && <span className="truncate text-sm">{group.label}</span>}
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
              "mb-0.5 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              active && "bg-muted text-foreground hover:bg-muted",
            )}
            aria-label={item.label}
          />
        }
      >
        <Icon className="size-3.5" weight={active ? "bold" : "regular"} />
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
      <Icon weight={active ? "bold" : "regular"} />
      {item.label}
      {item.entity && <NavigationCountBadge entity={item.entity} />}
    </DropdownMenuItem>
  );
}
