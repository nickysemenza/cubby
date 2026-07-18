import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreatePurchaseDialog } from "./create-purchase-dialog";

/** The Purchases list toolbar action: opens the quick-add dialog (no
 * /purchases/new route — this is the primary data-entry path, so it stays a
 * single click from the list). */
export function PurchaseActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New
      </Button>
      <CreatePurchaseDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
