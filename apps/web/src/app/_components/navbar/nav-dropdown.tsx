import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import { type NavGroup, useActiveTo } from "../navigation/nav-items";

export const NavDropdown = ({ group }: { group: NavGroup }) => {
  const { label, icon: Icon, children } = group;
  const activeTo = useActiveTo();
  const isGroupActive = children.some((item) => item.to === activeTo);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "nav-link-animated flex items-center gap-2 font-medium text-sm transition-colors hover:text-primary focus:outline-none",
          isGroupActive ? "text-foreground" : "text-muted-foreground",
        )}
        data-status={isGroupActive ? "active" : undefined}
        title={label}
      >
        <Icon className="h-4 w-4" />
        <span className="hidden lg:inline">{label}</span>
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {children.map((item) => {
          const ItemIcon = item.icon;
          return (
            <DropdownMenuItem
              key={item.to}
              render={<Link to={item.to} />}
              className={cn("gap-2", item.to === activeTo && "bg-accent")}
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
