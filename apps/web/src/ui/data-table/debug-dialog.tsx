import { useState, type ReactElement } from "react";

import { MutedBox } from "~/ui/layout/muted-box";
import { Overlay } from "~/ui/overlays/overlay";
import { DialogTrigger } from "~/ui/primitives/dialog";

import JsonRenderer from "../text/json-renderer";

interface DebugDialogProps {
  data: unknown;
  trigger: ReactElement;
  title?: string;
}

export function DebugDialog({
  data,
  trigger,
  title = "Debug Data",
}: DebugDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Overlay
      open={open}
      onOpenChange={setOpen}
      title={title}
      size="full"
      trigger={<DialogTrigger render={trigger} />}
    >
      <MutedBox className="overflow-auto">
        <JsonRenderer input={data} pretty />
      </MutedBox>
    </Overlay>
  );
}
