import { Plus } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import { Button } from "~/components/ui/button";

type CreateDialog = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

/** Shared list-toolbar trigger for entities created in a dialog. */
export function CreateDialogAction({
  Dialog,
  children = "New",
}: {
  Dialog: CreateDialog;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        {children}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} />
    </>
  );
}
