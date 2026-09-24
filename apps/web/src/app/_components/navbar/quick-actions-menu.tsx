import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
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
import { EntityIcon, entities } from "~/entities/entities";

import { actionsForSurface } from "../actions/action-items";

const createActions = actionsForSurface("navbar-create");

export const QuickActionsMenu = () => {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  aria-label="Quick actions"
                />
              }
            />
          }
        >
          <PlusIcon className="size-4" />
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
