import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateFinancialTransactionDialog } from "./create-financial-transaction-dialog";
export function FinancialTransactionActions() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New
      </Button>
      <CreateFinancialTransactionDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
