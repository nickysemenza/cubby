import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { Link } from "@tanstack/react-router";

import { EntityIcon, entities } from "~/entity/entities";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";
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

import { actionsForSurface } from "../actions/action-items";

const createActions = actionsForSurface("navbar-create");

export const QuickActionsMenu = ({ expanded }: { expanded?: boolean }) => {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant={expanded ? "default" : "ghost"}
                  size="sm"
                  className={cn(
                    "h-8 px-2",
                    expanded !== undefined && "size-7 p-0",
                    expanded && "lg:w-full lg:justify-start lg:px-2",
                  )}
                  aria-label="Quick actions"
                />
              }
            />
          }
        >
          <PlusIcon className="size-4" />
          {expanded && <span className="hidden lg:inline">Create</span>}
        </TooltipTrigger>
        <TooltipContent>
          <p>Quick actions</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Create</DropdownMenuLabel>
          {createActions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              render={<Link to={action.path} search={action.search} />}
            >
              {action.entity ? (
                <>
                  <EntityIcon entity={action.entity} colored />
                  <span>New {entities[action.entity].label}</span>
                </>
              ) : (
                <>
                  <action.icon />
                  <span>{action.name}</span>
                </>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
