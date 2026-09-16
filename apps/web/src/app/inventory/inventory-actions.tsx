import { Link } from "@tanstack/react-router";
import { EllipsisVertical, Plus } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

import { actionItems } from "../_components/actions/action-items";

// Contextual inventory actions, sourced from the canonical registry so their
// labels/paths stay single-sourced with the palette + navbar.
const byId = (id: string) => {
  const action = actionItems.find((a) => a.id === id);
  if (!action) throw new Error(`Unknown action id: ${id}`);
  return action;
};

const recount = byId("recount");
const bulkEdit = byId("bulk-edit");
const singleItem = byId("single-item");

export function InventoryActions() {
  return (
    <>
      <Link to={recount.path}>
        <Button variant="default" size="default" className="gap-1 text-xs">
          <recount.icon className="size-3.5" />
          {recount.name}
        </Button>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              aria-label="More inventory actions"
            >
              <EllipsisVertical className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem render={<Link to={bulkEdit.path} />}>
            {bulkEdit.name}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link to={singleItem.path} search={singleItem.search} />}
          >
            <Plus />
            {singleItem.name}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
