import { Link } from "@tanstack/react-router";
import { type LucideIcon, Plus, ScanBarcode } from "lucide-react";
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
import type { Entity } from "~/entities/types";

type EntityAction = {
  entity: Entity;
  description?: string;
};

type CustomAction = {
  label: string;
  href: string;
  icon: LucideIcon;
  description?: string;
};

type QuickAction = EntityAction | CustomAction;

const isEntityAction = (action: QuickAction): action is EntityAction =>
  "entity" in action;

export const quickActions: QuickAction[] = [
  { entity: "product" },
  { entity: "location" },
  { entity: "recipe" },
  {
    label: "Add Inventory",
    href: "/inventory/quick-capture",
    icon: ScanBarcode,
    description: "Scan or batch entry",
  },
];

export const QuickActionsMenu = () => {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="sm" className="h-8 px-2" />}
            />
          }
        >
          <Plus className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Quick actions</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Create</DropdownMenuLabel>
          {quickActions.map((action) => {
            if (isEntityAction(action)) {
              const def = entities[action.entity];
              return (
                <DropdownMenuItem
                  key={action.entity}
                  render={<Link to={def.routes.new!} />}
                >
                  <EntityIcon
                    entity={action.entity}
                    className="h-4 w-4"
                    colored
                  />
                  <span>New {def.label}</span>
                </DropdownMenuItem>
              );
            }
            return (
              <DropdownMenuItem
                key={action.href}
                render={<Link to={action.href} />}
              >
                <action.icon className="h-4 w-4" />
                <span>{action.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
