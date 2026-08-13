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
    <div
      className={cn(
        "w-full min-w-0",
        // Cap content for readable line-lengths, but let very large displays
        // breathe instead of stranding a 1280px column in an ocean of margin.
        !fullWidth && "mx-auto max-w-7xl 2xl:max-w-[90rem]",
        className,
      )}
    >
      {children}
    </div>
  );
};
