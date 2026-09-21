import { Network } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
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

const inspectLabel = (title: string) => `Inspect ${title.toLocaleLowerCase()}`;

/** The whole summary is the control. Only valid when the summary is inert. */
function SummaryTrigger({
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
      aria-label={inspectLabel(title)}
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
 * Icon-only control beside the summary, styled like the inventory cell's
 * quick-edit pencil so the two read as one family of cell affordances. Spread
 * onto a `Button` (also as a Base UI `render` element, which merges its own
 * handlers with `onClick`).
 */
const iconTriggerProps = (title: string) => ({
  size: "icon" as const,
  variant: "ghost" as const,
  className:
    "size-5 shrink-0 opacity-40 transition-opacity group-hover/workbench:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
  "aria-label": inspectLabel(title),
  onClick: stopRowInteraction,
});

const iconTriggerGlyph = <Network className="size-3 text-muted-foreground" />;

/**
 * A dense table-cell entry point for evidence that belongs to related rows.
 * The body mounts only while open so a list does not start one relation query
 * per visible row. Desktop keeps the context beside the cell; phones use a
 * bottom sheet with the platform's 44px trigger floor.
 *
 * `trigger` picks what is clickable. `"summary"` wraps the summary in the
 * control and is only valid for inert content (a status pill). A summary that
 * carries its own links, edit trigger, or buttons must use `"icon"`, which
 * renders the summary as a sibling of an icon-only control: interactive
 * content inside a `<button>` is invalid HTML and React reports it as a
 * hydration error.
 */
export function TableCellWorkbench({
  title,
  description,
  summary,
  children,
  trigger = "summary",
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  description?: string;
  summary: ReactNode;
  children: ReactNode;
  trigger?: "summary" | "icon";
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
        {trigger === "icon" ? (
          <Row align="center" gap="xs" className="group/workbench min-w-0">
            <span className="min-w-0">{summary}</span>
            <Button
              {...iconTriggerProps(title)}
              onClick={(event) => {
                stopRowInteraction(event);
                setOpen(true);
              }}
            >
              {iconTriggerGlyph}
            </Button>
          </Row>
        ) : (
          <SummaryTrigger
            title={title}
            summary={summary}
            onClick={() => setOpen(true)}
          />
        )}
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

  const popoverTrigger =
    trigger === "icon" ? (
      <Row align="center" gap="xs" className="group/workbench min-w-0">
        <span className="min-w-0">{summary}</span>
        <PopoverTrigger render={<Button {...iconTriggerProps(title)} />}>
          {iconTriggerGlyph}
        </PopoverTrigger>
      </Row>
    ) : (
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={inspectLabel(title)}
            className="inline-flex min-h-7 max-w-full items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={stopRowInteraction}
          />
        }
      >
        {summary}
      </PopoverTrigger>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {popoverTrigger}
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
