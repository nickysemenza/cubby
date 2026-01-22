import { Link } from "@tanstack/react-router";
import { Plus, ScanBarcode } from "lucide-react";
import { Button } from "~/components/ui/button";

export function InventoryActions() {
  return (
    <>
      <Link to="/inventory/quick-capture">
        <Button variant="default">
          <ScanBarcode className="mr-1 h-4 w-4" />
          Add Inventory
        </Button>
      </Link>
      <Link to="/inventory/bulk-edit">
        <Button variant="outline">Inventory Audit</Button>
      </Link>
      <Link to="/inventory/new">
        <Button variant="outline">
          <Plus className="mr-1 h-4 w-4" />
          Single Item
        </Button>
      </Link>
    </>
  );
}
