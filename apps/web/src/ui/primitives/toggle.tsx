"use client"

import { cva } from "class-variance-authority"

// The segmented control: Inter 12/500 sentence case, secondary at rest, the
// pressed option on the inset tone in graphite (DESIGN.md "Chips" — full
// pills and uppercase are reserved; a segmented choice is a quiet inset).
const toggleVariants = cva(
  "text-muted-foreground hover:text-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive gap-1.5 rounded-md text-xs font-medium transition-colors duration-150 [&_svg:not([class*='size-'])]:size-3.5 group/toggle inline-flex items-center justify-center whitespace-nowrap outline-none focus-visible:ring-[2px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border border bg-transparent",
      },
      size: {
        default: "h-8 min-w-8 px-2.5",
        sm: "h-7 min-w-7 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export { toggleVariants }
