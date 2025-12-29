import type React from "react";
import { MutedBox } from "~/components/layout/muted-box";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import JsonRenderer from "../json-renderer";

interface DebugDialogProps {
  data: unknown;
  trigger: React.ReactElement;
  title?: string;
}

export function DebugDialog({
  data,
  trigger,
  title = "Debug Data",
}: DebugDialogProps) {
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent className="flex max-h-[80vh] max-w-6xl flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          <MutedBox className="overflow-auto">
            <JsonRenderer input={data} pretty />
          </MutedBox>
        </div>
      </DialogContent>
    </Dialog>
  );
}
