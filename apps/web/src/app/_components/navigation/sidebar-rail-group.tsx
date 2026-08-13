import { Link } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import { type NavGroup, type NavItem, settingsNavItem } from "./nav-items";

export function SidebarRailGroup({
  group,
  activeTo,
}: {
  group: NavGroup;
  activeTo: string | undefined;
}) {
  const children = group.children.filter(
    (item) => item.to !== settingsNavItem.to,
  );
  const active = children.some((item) => item.to === activeTo);
  const Icon = group.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn(
              "mb-1 flex size-10 items-center justify-center border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none",
              active && "border-border bg-background text-foreground",
            )}
            aria-label={group.label}
            aria-current={active ? "page" : undefined}
            title={group.label}
          />
        }
      >
        <Icon className="size-3.5" />
      </DropdownMenuTrigger>
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
      render={<Link to={item.to} preload="intent" preloadDelay={40} />}
      className={cn("gap-2", active && "bg-accent")}
    >
      <Icon className="size-3.5" />
      {item.label}
    </DropdownMenuItem>
  );
}
