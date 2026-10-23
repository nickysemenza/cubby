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
  const [mode, setMode] = useState<"closed" | "preview" | "pinned">("closed");
  const triggerId = useId();
  return (
    <Popover
      open={mode !== "closed"}
      triggerId={triggerId}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "trigger-hover" && mode === "pinned")
          return;
        if (details.reason === "trigger-press") {
          // A press pins a preview even when the primitive proposes closing it.
          setMode(mode === "pinned" ? "closed" : "pinned");
          return;
        }
        setMode(next ? "preview" : "closed");
      }}
    >
      <PopoverTrigger
        id={triggerId}
        openOnHover={mode !== "pinned"}
        delay={300}
        closeDelay={150}
        onFocus={(event) => {
          // Pointer focus must not turn a hover preview into a toggle before click.
          const from = event.relatedTarget;
          if (
            from instanceof Element &&
            from.closest('[data-slot="popover-content"]')
          )
            return;
          if (event.currentTarget.matches(":focus-visible")) setMode("preview");
        }}
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
