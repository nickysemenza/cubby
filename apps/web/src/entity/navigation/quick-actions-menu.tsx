import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";

import { EntityIcon, entities } from "~/entity/entities";
import { domainForEntity } from "~/ui/navigation/domain-wayfinding";
import { Button } from "~/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/ui/shadcn/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/shadcn/tooltip";

import { actionsForSurface } from "../actions/action-items";
import { navGroups } from "./nav-items";

const createActions = actionsForSurface("navbar-create");
const domainGroups = navGroups.map((group) => ({
  label: group.label,
  actions: createActions.filter(
    (action) =>
      action.entity && domainForEntity(action.entity) === group.domain,
  ),
}));
const groupedActions = new Set(domainGroups.flatMap((group) => group.actions));
/** Create follows the sidebar's domains; anything without one leads as Create. */
const createGroups = [
  {
    label: "Create",
    actions: createActions.filter((action) => !groupedActions.has(action)),
  },
  ...domainGroups,
].filter((group) => group.actions.length > 0);

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
        {createGroups.map((group) => (
          <DropdownMenuGroup key={group.label}>
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.actions.map((action) => (
              <DropdownMenuItem
                key={action.id}
                render={<Link to={action.path} search={action.search} />}
              >
                {action.entity ? (
                  <>
                    <EntityIcon entity={action.entity} />
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
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
