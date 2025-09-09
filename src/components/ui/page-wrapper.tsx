import { type ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface PageWrapperProps {
  children: ReactNode;
  className?: string;
}

export const PageWrapper = ({ children, className }: PageWrapperProps) => {
  return (
    <div
      className={cn("container mx-auto p-1", "terminal:max-w-none", className)}
    >
      {children}
    </div>
  );
};
