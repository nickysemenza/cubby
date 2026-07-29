import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateExpenseDialog } from "./create-expense-dialog";

/** The Expenses list toolbar action: opens the quick-add dialog (no
 * /expenses/new route — this is the primary data-entry path, so it stays a
 * single click from the list). */
export function ExpenseActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New
      </Button>
      <CreateExpenseDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
