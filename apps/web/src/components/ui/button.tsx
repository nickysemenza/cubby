import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

// Warm-Paper Ledger chrome (2026-06-25) - flat controls, zero elevation.
// Separation is by tone and rule, never shadow. Filled primary = the lone
// ultramarine; supporting variants carry an ink hairline; press dims tone,
// it doesn't flatten a shadow.
const ruled = "border-[var(--border)] active:opacity-90";

const buttonVariants = cva(
  "focus-visible:border-ring focus-visible:ring-ring/40 aria-invalid:ring-destructive/20 aria-invalid:border-destructive rounded-none border border-transparent bg-clip-padding text-xs/relaxed font-medium focus-visible:ring-[2px] aria-invalid:ring-[2px] [&_svg:not([class*='size-'])]:size-3.5 inline-flex items-center justify-center whitespace-nowrap transition-colors duration-100 ease-cozy disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[var(--brand-ultramarine-dark)] active:opacity-90",
        outline: `bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground ${ruled}`,
        secondary: `bg-secondary text-secondary-foreground hover:bg-[var(--brand-hairline)] aria-expanded:bg-[var(--brand-hairline)] aria-expanded:text-secondary-foreground ${ruled}`,
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive: `border-destructive/30 bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 text-destructive ${ruled}`,
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 px-2 text-2xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-2 px-3 text-sm [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-5 [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
      },
      /**
       * Cubby is used on an iOS PWA as well as at a desktop desk. Interactive
       * controls therefore grow to the 44px iOS phone floor by default while
       * retaining their compact ledger density at the `md` desktop shell.
       *
       * `compact` is only for a composite whose enclosing interactive target
       * already supplies at least 44×44px (or desktop-only chrome). Document
       * that enclosing target at the call site; never use this just to fit more
       * actions into a phone row.
       */
      mobileSize: {
        touch: "max-md:min-h-11 max-md:min-w-11",
        compact: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      mobileSize: "touch",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  mobileSize = "touch",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, mobileSize, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
