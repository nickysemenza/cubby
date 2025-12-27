import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import BulkMoveForm from "./bulk-move-form";

export const metadata = {
  title: "Bulk Move Inventory",
  description: "Move multiple inventory items between locations",
};

export default function BulkMovePage() {
  return (
    <PageWrapper>
      <Card>
        <CardHeader>
          <CardTitle>Bulk Move Inventory</CardTitle>
          <CardDescription>
            Move multiple items from one location to another
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BulkMoveForm />
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
