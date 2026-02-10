import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

interface PageWrapperProps {
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
}

export const PageWrapper = ({
  children,
  className,
  fullWidth,
}: PageWrapperProps) => {
  return (
    <div className={cn("w-full", !fullWidth && "mx-auto max-w-7xl", className)}>
      {children}
    </div>
  );
};
