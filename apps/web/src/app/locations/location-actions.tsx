import { Link } from "@tanstack/react-router";
import { Plus, Tags } from "lucide-react";
import { Button } from "~/components/ui/button";

export function LocationActions() {
  return (
    <div className="flex items-center gap-2">
      <Link to="/labels">
        <Button variant="outline" className="gap-1">
          <Tags className="h-4 w-4" />
          Print labels
        </Button>
      </Link>
      <Link to="/locations/new">
        <Button className="gap-1">
          <Plus className="h-4 w-4" />
          Create New Location
        </Button>
      </Link>
    </div>
  );
}
