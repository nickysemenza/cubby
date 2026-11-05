// Source: ReUI @reui/alert, base-mira.
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "cn"

const alertVariants = cva(
  [
    "group/alert relative w-full text-xs/relaxed border grid-cols-[1fr] has-[>svg]:grid-cols-[auto_1fr] has-data-[slot=alert-action]:sm:grid-cols-[1fr_auto] has-[>svg]:has-data-[slot=alert-action]:sm:grid-cols-[auto_1fr_auto] grid gap-y-0.5 items-center [&>svg:not([class*=size-])]:size-4",
    "has-[>[data-slot=alert-title]+[data-slot=alert-description]]:[&_[data-slot=alert-action]]:sm:row-end-3",
    "has-[>[data-slot=alert-title]+[data-slot=alert-description]]:items-start",
    "has-[>[data-slot=alert-title]+[data-slot=alert-description]]:[&_svg]:translate-y-0.5",
    "rounded-lg",
    "px-3",
    "py-2.5",
    "has-[>svg]:gap-x-2.5",
  ],
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "text-destructive bg-card *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
        info: "border-info/30 bg-info/4 [&>svg]:text-info",
        success: "border-success/30 bg-success/4 [&>svg]:text-success",
        warning: "border-warning/30 bg-warning/4 [&>svg]:text-warning",
        invert:
          "border-invert bg-invert text-invert-foreground [&_[data-slot=alert-description]]:text-invert-foreground/70",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "min-w-0 font-semibold group-has-[>svg]/alert:col-start-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground min-w-0 text-xs/relaxed group-has-[>svg]/alert:col-start-2 [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "flex gap-1.5 max-sm:col-start-1 group-has-[>svg]/alert:max-sm:col-start-2 max-sm:mt-2 max-sm:justify-start sm:col-start-2 group-has-[>svg]/alert:sm:col-start-3 sm:row-start-1 sm:justify-end sm:self-center",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }