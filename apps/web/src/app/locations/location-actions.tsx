import { Link } from "@tanstack/react-router";
import { Plus, Tags } from "lucide-react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";

export function LocationActions() {
  return (
    <Row align="center" gap="sm">
      <Link to="/labels">
        <Button variant="outline" className="gap-1">
          <Tags className="h-4 w-4" />
          Print labels
        </Button>
      </Link>
      <Link to="/locations/new">
        <Button className="gap-1">
          <Plus className="h-4 w-4" />
          New
        </Button>
      </Link>
    </Row>
  );
}
