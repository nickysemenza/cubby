import { createFileRoute } from "@tanstack/react-router";
import BulkInventoryForm from "~/app/inventory/bulk-edit/bulk-inventory-form";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/inventory/bulk-edit")({
  component: BulkInventoryEditPage,
  server: {
    middleware: [authMiddleware],
  },
});

function BulkInventoryEditPage() {
  return (
    <PageWrapper>
      <Card>
        <CardHeader>
          <CardTitle>Bulk Inventory Edit</CardTitle>
          <CardDescription>
            Perform a full inventory check on a specific location
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BulkInventoryForm />
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
