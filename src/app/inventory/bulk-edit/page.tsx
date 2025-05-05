import { WasmContextProvider } from "~/wasmContext";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import BulkInventoryForm from "./bulk-inventory-form";

export const metadata = {
  title: "Bulk Inventory Edit",
  description: "Edit multiple inventory items at once for a location",
};

export default function BulkInventoryEditPage() {
  return (
    <WasmContextProvider>
      <div className="container mx-auto py-6">
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
      </div>
    </WasmContextProvider>
  );
}
