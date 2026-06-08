import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

// Tactile "chunky" chrome - a 2px foreground border with a crisp offset shadow
// that lifts on hover and presses into its own shadow on active. Shared by the
// substantive button variants; ghost/link stay flat so toolbars don't get noisy.
const chunky =
  "border-2 border-[var(--border-chunky)] shadow-[var(--shadow-chunky-sm)] hover:shadow-[var(--shadow-chunky)] hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-none";

const buttonVariants = cva(
  "focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 aria-invalid:border-destructive rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-mono font-medium focus-visible:ring-[2px] aria-invalid:ring-[2px] [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all duration-150 ease-cozy disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none",
  {
    variants: {
      variant: {
        default: `bg-primary text-primary-foreground hover:bg-primary/80 ${chunky}`,
        outline: `bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground ${chunky}`,
        secondary: `bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground ${chunky}`,
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive: `bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 text-destructive ${chunky}`,
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        // Tiny sizes: thin border + small static offset, no hover-grow, so they
        // don't read as visually overweight at ~20px tall.
        xs: "h-5 gap-1 rounded-sm border px-2 text-2xs hover:translate-x-0 hover:translate-y-0 hover:shadow-[var(--shadow-chunky-sm)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs":
          "size-5 rounded-sm border hover:translate-x-0 hover:translate-y-0 hover:shadow-[var(--shadow-chunky-sm)] [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
