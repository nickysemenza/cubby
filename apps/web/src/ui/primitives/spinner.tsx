import { cn } from "~/lib/utils";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";

const sizeClasses = {
  sm: "size-3",
  default: "size-4",
  md: "size-6",
  lg: "size-8",
} as const;

type SpinnerSize = keyof typeof sizeClasses;

interface SpinnerProps extends Omit<React.ComponentProps<"svg">, "size"> {
  size?: SpinnerSize;
}

function Spinner({ className, size = "default", ...props }: SpinnerProps) {
  return (
    <CircleNotchIcon
      role="status"
      aria-label="Loading"
      className={cn("animate-spin", sizeClasses[size], className)}
      {...props}
    />
  );
}

export { Spinner,  };
