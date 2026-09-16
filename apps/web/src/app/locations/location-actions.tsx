import { Link } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { captureRequest } from "~/entities/editing/editor-requests";

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
      <CreateDialogAction request={captureRequest("location")}>
        New
      </CreateDialogAction>
    </Row>
  );
}
