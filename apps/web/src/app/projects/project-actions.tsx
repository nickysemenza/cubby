import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateProjectDialog } from "./create-project-dialog";

/** The dashboard's toolbar action: opens the quick-add dialog (no
 * /projects/new route — mirrors `TaskActions`/`ExpenseActions`). */
export function ProjectActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New Project
      </Button>
      <CreateProjectDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
