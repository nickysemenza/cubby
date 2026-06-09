import { Link } from "@tanstack/react-router";
import { EllipsisVertical, Plus, ScanBarcode } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export function InventoryActions() {
  return (
    <>
      <Link to="/inventory/quick-capture">
        <Button variant="default" size="sm" className="h-7 gap-1 text-xs">
          <ScanBarcode className="h-3.5 w-3.5" />
          Add Inventory
        </Button>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              aria-label="More inventory actions"
            >
              <EllipsisVertical className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem render={<Link to="/inventory/bulk-edit" />}>
            Inventory Audit
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/inventory/new" />}>
            <Plus className="h-4 w-4" />
            Single Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
