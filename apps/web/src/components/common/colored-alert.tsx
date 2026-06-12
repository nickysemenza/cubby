import type { ComponentProps } from "react";
import { Alert } from "~/components/ui/alert";
import { cn } from "~/lib/utils";

type ColoredAlertVariant =
  | "default"
  | "destructive"
  | "success"
  | "warning"
  | "info";

const variantClasses: Record<ColoredAlertVariant, string> = {
  default: "",
  destructive: "",
  success:
    "border-secondary bg-secondary text-secondary-foreground [&>svg]:text-secondary-foreground",
  warning:
    "border-warning bg-warning/30 text-accent-foreground [&>svg]:text-accent-foreground",
  info: "border-slate/30 bg-slate/10 text-slate [&>svg]:text-slate",
};

interface ColoredAlertProps
  extends Omit<ComponentProps<typeof Alert>, "variant"> {
  variant?: ColoredAlertVariant;
}

export const ColoredAlert = ({
  variant = "default",
  className,
  ...props
}: ColoredAlertProps) => (
  <Alert
    variant={variant === "destructive" ? "destructive" : "default"}
    className={cn(variantClasses[variant], className)}
    {...props}
  />
);
