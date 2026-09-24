import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Link } from "@tanstack/react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

import {
  type NavGroup,
  navItemLinkProps,
  useActiveTo,
} from "../navigation/nav-items";

export const NavDropdown = ({ group }: { group: NavGroup }) => {
  const { label, icon: Icon, children } = group;
  const activeTo = useActiveTo();
  const isGroupActive = children.some((item) => item.to === activeTo);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "nav-link-animated flex items-center gap-2 text-sm font-medium transition-colors hover:text-primary focus:outline-none",
          isGroupActive ? "text-foreground" : "text-muted-foreground",
        )}
        data-status={isGroupActive ? "active" : undefined}
        title={label}
      >
        <Icon
          className="size-3.5"
          weight={isGroupActive ? "bold" : "regular"}
        />
        <span className="hidden lg:inline">{label}</span>
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {children.map((item) => {
          const ItemIcon = item.icon;
          return (
            <DropdownMenuItem
              key={item.to}
              render={
                <Link {...navItemLinkProps(item, item.to === activeTo)} />
              }
              className={cn("gap-2", item.to === activeTo && "bg-accent")}
            >
              <ItemIcon weight={item.to === activeTo ? "bold" : "regular"} />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
