import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateVendorDialog } from "./create-vendor-dialog";

/** The roster's toolbar action: opens the quick-add dialog (no /vendors/new
 * route — mirrors `ProjectActions`/`ExpenseActions`). */
export function VendorActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New Vendor
      </Button>
      <CreateVendorDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
