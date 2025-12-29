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
    "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300 [&>svg]:text-green-600",
  warning:
    "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300 [&>svg]:text-yellow-600",
  info: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300 [&>svg]:text-blue-600",
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
