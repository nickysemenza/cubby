import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateFinancialAccountDialog } from "./create-financial-account-dialog";
export function FinancialAccountActions() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New
      </Button>
      <CreateFinancialAccountDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
