import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { useIsMobile } from "~/hooks/useMobile";

function stopRowInteraction(event: MouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

function WorkbenchTrigger({
  title,
  summary,
  onClick,
}: {
  title: string;
  summary: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Inspect ${title.toLocaleLowerCase()}`}
      className="inline-flex min-h-7 max-w-full items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary max-md:min-h-11"
      onClick={(event) => {
        stopRowInteraction(event);
        onClick?.();
      }}
    >
      {summary}
    </button>
  );
}

/**
 * A dense table-cell entry point for evidence that belongs to related rows.
 * The body mounts only while open so a list does not start one relation query
 * per visible row. Desktop keeps the context beside the cell; phones use a
 * bottom sheet with the platform's 44px trigger floor.
 */
export function TableCellWorkbench({
  title,
  description,
  summary,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  description?: string;
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  if (isMobile) {
    return (
      <>
        <WorkbenchTrigger
          title={title}
          summary={summary}
          onClick={() => setOpen(true)}
        />
        <ResponsiveSheet
          open={open}
          onOpenChange={setOpen}
          title={title}
          description={description}
          className="md:max-w-2xl"
        >
          {open ? children : null}
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Inspect ${title.toLocaleLowerCase()}`}
            className="inline-flex min-h-7 max-w-full items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={stopRowInteraction}
          />
        }
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(42rem,calc(100vw-2rem))] p-0"
      >
        <PopoverHeader className="border-b border-border px-4 py-3">
          <PopoverTitle>{title}</PopoverTitle>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </PopoverHeader>
        <div className="max-h-[min(36rem,70vh)] overflow-y-auto p-4">
          {open ? children : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
