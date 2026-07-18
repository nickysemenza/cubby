import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateTaskDialog } from "./create-task-dialog";

/** The Tasks list toolbar action: opens the quick-add dialog (no /tasks/new
 * route — rows are shallow, created and edited entirely from the list). */
export function TaskActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New
      </Button>
      <CreateTaskDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
