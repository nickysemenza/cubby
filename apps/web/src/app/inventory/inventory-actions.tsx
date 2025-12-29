import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { Button } from "~/components/ui/button";

export function InventoryActions() {
  return (
    <>
      <Link to="/inventory/quick-capture">
        <Button variant="default">
          <Zap className="mr-1 h-4 w-4" />
          Quick Capture
        </Button>
      </Link>
      <Link to="/inventory/bulk-edit">
        <Button variant="outline">Bulk Edit</Button>
      </Link>
      <Link to="/inventory/new">
        <Button variant="outline">Create New</Button>
      </Link>
    </>
  );
}
