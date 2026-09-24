"use client";

import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretLeftIcon as ChevronLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretUpIcon as ChevronUp } from "@phosphor-icons/react/dist/csr/CaretUp";
import type { ComponentProps } from "react";
import type { ChevronProps } from "react-day-picker";
import { DayPicker } from "react-day-picker";

import { cn } from "~/lib/utils";

/**
 * Porcelain Transit wrapper over react-day-picker v10's `DayPicker`.
 *
 * v10 renders the month grid as a plain `<table>` (`MonthGrid`/`Weeks`/`Week`
 * are `<table>`/`<tbody>`/`<tr>`, `Day`/`Weekday` are `<td>`/`<th>` — see
 * `node_modules/react-day-picker/dist/esm/components/*.js`), so no base
 * stylesheet is needed for layout; fully custom `classNames` are enough. We
 * default `navLayout="around"` so the prev/next buttons render as plain
 * siblings of the month caption (a 3-column grid row) instead of the legacy
 * `Nav` element, which the default stylesheet absolutely-positions — a hack
 * we'd otherwise have to reproduce by hand.
 *
 * Selection/today/outside/disabled modifiers land on the day `<td>`, not the
 * `<button>` (`DayButton` only gets the `day_button` class) — so those
 * classNames use `[&_button]:…` to reach the button inside.
 */
function Calendar({
  className,
  classNames,
  components,
  showOutsideDays = true,
  navLayout = "around",
  ...props
}: ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      navLayout={navLayout}
      className={cn("w-fit p-2", className)}
      classNames={{
        months: "flex flex-col gap-2",
        month: "grid grid-cols-[auto_1fr_auto] items-center gap-y-1",
        month_caption:
          "col-span-1 flex items-center justify-center px-1 font-mono text-xs font-medium uppercase tracking-wide text-foreground",
        button_previous:
          "inline-flex size-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        button_next:
          "inline-flex size-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        month_grid: "col-span-3 mt-1 w-full border-collapse",
        weekdays: "",
        weekday:
          "w-8 pb-1 text-center font-mono text-2xs font-medium uppercase tracking-wide text-muted-foreground",
        weeks: "",
        week: "",
        day: "p-0 text-center align-middle",
        day_button:
          "inline-flex size-8 items-center justify-center bg-transparent font-mono text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-30",
        selected:
          "[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary [&_button]:hover:text-primary-foreground",
        today:
          "[&_button]:underline [&_button]:decoration-2 [&_button]:decoration-primary [&_button]:underline-offset-2",
        outside: "opacity-70 [&_button]:text-muted-foreground",
        disabled: "[&_button]:pointer-events-none [&_button]:opacity-30",
        hidden: "invisible",
        range_start:
          "[&_button]:bg-primary [&_button]:text-primary-foreground",
        range_middle: "[&_button]:bg-accent [&_button]:text-accent-foreground",
        range_end: "[&_button]:bg-primary [&_button]:text-primary-foreground",
        ...classNames,
      }}
      components={{
        Chevron: CalendarChevron,
        ...components,
      }}
      {...props}
    />
  );
}

function CalendarChevron({ className, orientation }: ChevronProps) {
  const Icon =
    orientation === "up"
      ? ChevronUp
      : orientation === "down"
        ? ChevronDown
        : orientation === "right"
          ? ChevronRight
          : ChevronLeft;
  return <Icon className={cn("size-4", className)} />;
}

export { Calendar };
