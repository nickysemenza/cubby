import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import BulkInventoryForm from "./bulk-inventory-form";

export const metadata = {
  title: "Bulk Inventory Edit",
  description: "Edit multiple inventory items at once for a location",
};

export default function BulkInventoryEditPage() {
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
