import { Link } from "@tanstack/react-router";
import { LayoutDashboard, Plus } from "lucide-react";
import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";

export function LocationActions() {
  return (
    <Row align="center" gap="sm">
      <Link to="/locations/arrange">
        <Button variant="outline" className="gap-1">
          <LayoutDashboard className="size-4" />
          Arrange
        </Button>
      </Link>
      <VerbButton
        verb="printLabels"
        render={<Link to="/labels" />}
        className="gap-1"
      />
      <Link to="/locations/new">
        <Button className="gap-1">
          <Plus className="size-4" />
          New
        </Button>
      </Link>
    </Row>
  );
}
