import { type ReactNode, useId, useState } from "react";

import { copyTextWithToast } from "~/lib/clipboard";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";

/** Explicit readable/raw pairs only; essential information stays in the label. */
export function InspectableValue({
  children,
  value,
  className,
}: {
  children: ReactNode;
  value: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen} triggerId={triggerId}>
      <PopoverTrigger
        id={triggerId}
        openOnHover
        delay={300}
        closeDelay={150}
        onFocus={() => setOpen(true)}
        className={cn(
          "max-w-full cursor-help rounded-sm text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
        <span className="sr-only"> — inspect raw value</span>
      </PopoverTrigger>
      <PopoverContent align="start" initialFocus={false}>
        <PopoverTitle className="text-xs text-muted-foreground">
          Raw value
        </PopoverTitle>
        <code className="text-xs break-all whitespace-pre-wrap select-text">
          {value}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyTextWithToast(value, "Raw value copied")}
        >
          Copy raw value
        </Button>
      </PopoverContent>
    </Popover>
  );
}
