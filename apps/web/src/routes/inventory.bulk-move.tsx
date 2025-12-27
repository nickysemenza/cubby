import { createFileRoute } from "@tanstack/react-router";
import BulkMoveForm from "~/app/inventory/bulk-move/bulk-move-form";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

export const Route = createFileRoute("/inventory/bulk-move")({
  component: BulkInventoryMovePage,
});

function BulkInventoryMovePage() {
  return (
    <PageWrapper>
      <Card>
        <CardHeader>
          <CardTitle>Bulk Move Inventory</CardTitle>
          <CardDescription>
            Move multiple inventory items to a different location
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BulkMoveForm />
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
