import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

interface PageWrapperProps {
  children: ReactNode;
  className?: string;
}

export const PageWrapper = ({ children, className }: PageWrapperProps) => {
  return <div className={cn("w-full", className)}>{children}</div>;
};
