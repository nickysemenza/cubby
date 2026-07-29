import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CreateMealDialog } from "./create-meal-dialog";

/** The Meals page's header action: opens the quick-add dialog. Rendered via
 * `<Page actions={...}>`, the only slot shared by both the calendar and
 * table views — the calendar keeps its own per-day "+ Meal" affordance. */
export function MealActions() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New
      </Button>
      <CreateMealDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
